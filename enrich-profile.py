#!/usr/bin/env python3
"""
Профиль лида: «о себе», день рождения, бизнес-данные и — если в профиле есть
личный канал — его последние 20 постов. Модель достаёт из этого факты для
будущего личного письма и заодно проверяет, не продавец ли это сам (риелтор,
агент, посредник): такого из лидов убираем.

Порциями, аккаунтом-читателем. Доступ к человеку — без вступлений:
  1) из сессии: этот читатель видел его сообщения, access_hash уже есть;
  2) по @нику;
  3) через его сообщение в публичном чате (InputUserFromMessage), как пишет писатель.

    python enrich-profile.py --account r1 [--per-run 15]
"""
import asyncio
import json
import random
import re

import enrich
import llm
import tglib
from chatlib import chat_ref
from tglib import say

PER_RUN = 15
POSTS = 20                # постов личного канала
PAUSE = (2, 4)
FLOOD_MAX = 120

PROMPT = """Ищем людей, которые {goal}. Этого человека уже нашли в чатах как
подходящего: «{why}». Ниже его профиль в Telegram{chan}.

{body}

Ответь СТРОГО одним JSON без пояснений вокруг:
{{"seller": true|false, "facts": {{"поле": "значение"}}, "note": "заметка"}}

seller=true — только если по профилю или каналу видно, что человек сам
продаёт или предлагает это как работу (агент, посредник, продавец, компания).
facts — короткие факты, полезные для личного письма: работа, город, семья,
интересы, увлечения, чем живёт, что для него важно, день рождения. Только то,
что видно, без догадок; неизвестное не пиши.
note — 2–5 строк markdown: кто это и что из профиля важно для разговора."""


async def input_user(client, lead):
    """
    Доступ к человеку для GetFullUser: сперва кеш сессии (читатель видел его
    сообщения), ник резолвим только когда кеша нет, последним — через сообщение.
    """
    from telethon.errors import FloodWaitError
    from telethon.tl.types import InputPeerUser, InputUser, InputUserFromMessage

    uid = int(lead["uid"])
    try:
        p = await client.get_input_entity(uid)
        if isinstance(p, InputPeerUser):
            return InputUser(p.user_id, p.access_hash)
    except (ValueError, TypeError):
        pass
    if lead.get("username"):
        try:
            p = await client.get_input_entity("@" + lead["username"])
            if isinstance(p, InputPeerUser) and p.user_id == uid:
                return InputUser(p.user_id, p.access_hash)
        except FloodWaitError:
            raise
        except Exception:
            pass                                    # ник сменили — пробуем через сообщение
    for ch in reversed(lead.get("chats") or []):
        ids = [int(i) for i in (ch.get("msg_ids") or [])][-5:]
        r, invite = chat_ref(ch.get("ref") or "") if ch.get("ref") else (None, None)
        if not ids or not r or invite:
            continue                                # в закрытый чат ради профиля не вступаем
        try:
            peer = await client.get_input_entity(r)
            for m in await client.get_messages(peer, ids=ids):
                if m is not None and m.sender_id == uid:
                    return InputUserFromMessage(peer=peer, msg_id=m.id, user_id=uid)
        except FloodWaitError:
            raise
        except Exception:
            continue
    return None


def bday(b):
    if not b:
        return ""
    return f"{b.day:02d}.{b.month:02d}" + (f".{b.year}" if getattr(b, "year", None) else "")


async def collect(client, iu, uid):
    """Профиль: что о себе, бизнес, личный канал и его посты."""
    from telethon import functions

    full = await client(functions.users.GetFullUserRequest(iu))
    fu = full.full_user
    user = next((u for u in full.users if u.id == uid), None)
    prof = {"about": (fu.about or "").strip(), "birthday": bday(fu.birthday),
            "name": " ".join(x for x in [getattr(user, "first_name", ""), getattr(user, "last_name", "")] if x),
            "username": getattr(user, "username", "") or ""}
    if getattr(fu, "business_intro", None):
        prof["business"] = " — ".join(x for x in [fu.business_intro.title, fu.business_intro.description] if x)
    if getattr(fu, "business_location", None):
        prof["address"] = fu.business_location.address or ""
    posts = []
    if fu.personal_channel_id:
        chan = next((c for c in full.chats if c.id == fu.personal_channel_id), None)
        if chan is not None:
            prof["channel"] = {"title": getattr(chan, "title", ""), "username": getattr(chan, "username", "") or ""}
            for m in await client.get_messages(chan, limit=POSTS):
                if getattr(m, "message", None):
                    posts.append(f"[{m.date:%d.%m.%Y}] " + " ".join(m.message.split())[:700])
            prof["channel"]["posts"] = len(posts)
    return prof, posts


def ask(lead, prof, posts):
    """(seller, facts, note) — или None, если модель не ответила толком."""
    body = []
    if prof.get("name"):
        body.append(f"Имя: {prof['name']}")
    if prof.get("about"):
        body.append(f"О себе: {prof['about']}")
    if prof.get("birthday"):
        body.append(f"День рождения: {prof['birthday']}")
    if prof.get("business"):
        body.append(f"Бизнес-профиль: {prof['business']}")
    if prof.get("address"):
        body.append(f"Адрес бизнеса: {prof['address']}")
    if posts:
        body.append("Последние посты канала:\n" + "\n".join(posts))
    why = (lead.get("chats") or [{}])[-1].get("why", "")
    chan = f" и личный канал «{prof['channel']['title']}»" if prof.get("channel") else ""
    out = llm.chat("Отвечай строго в формате, который просят.",
                   PROMPT.format(goal=enrich.goal(), why=why, chan=chan, body="\n".join(body)[:9000]),
                   max_tokens=900, temperature=0.2)
    if out is None:
        return None
    for m in reversed(list(re.finditer(r'\{\s*"seller"', out))):
        try:
            d, _ = json.JSONDecoder().raw_decode(out, m.start())
        except ValueError:
            continue
        facts = {}
        for k, v in (d.get("facts") or {}).items() if isinstance(d.get("facts"), dict) else []:
            k, v = " ".join(str(k).split())[:40], " ".join(str(v).split())[:300]
            if k and v:
                facts[k] = v
        return bool(d.get("seller") is True or str(d.get("seller")).lower() == "true"), facts, str(d.get("note") or "")
    return "bad"


async def main():
    from telethon.errors import FloodWaitError

    acc = tglib.resolve(tglib.arg("account", ""))
    per_run = int(tglib.arg("per-run", 0) or 0) or PER_RUN
    say(f"аккаунт: {acc['title']}  |  профили лидов  |  {tglib.proxy_label(acc.get('proxy'))}")
    todo = enrich.profile_todo()
    if not todo:
        say("профили всех лидов уже посмотрены")
        tglib.state(done=0, left=0)
        return
    # сначала лиды из чатов, которые читал этот аккаунт: они уже в кеше сессии
    readers = {str(v.get("chat_id")): v.get("reader") for v in enrich.load_chats().values() if v.get("chat_id")}
    mine = lambda l: any(readers.get(str(c.get("chat_id"))) == acc["id"] for c in l.get("chats") or [])
    todo.sort(key=lambda l: not mine(l))
    say(f"профилей к просмотру: {len(todo)}, за этот заход до {per_run}")

    client = await tglib.connect(acc)
    done = 0
    stop, wait = "", 0
    try:
        for n, lead in enumerate(todo[:per_run]):
            who = f"@{lead['username']}" if lead.get("username") else f"id{lead['uid']} ({lead.get('name', '')})"
            try:
                iu = await input_user(client, lead)
                if iu is None:
                    enrich.save_profile(lead["uid"], err="нет доступа к человеку")
                    say(f"  {who}: к профилю не подступиться — позже")
                    continue
                prof, posts = await collect(client, iu, int(lead["uid"]))
            except FloodWaitError as e:
                say(f"  флуд-пауза {e.seconds} с")
                if e.seconds > FLOOD_MAX:
                    wait = e.seconds
                    break
                await asyncio.sleep(e.seconds)
                continue
            except Exception as e:
                msg = str(e).splitlines()[0][:100] if str(e) else type(e).__name__
                if tglib.is_frozen_error(e) or isinstance(e, (ConnectionError, OSError)):
                    say(f"  {who}: {msg} — это про аккаунт или связь, остановлюсь")
                    stop = "errors"
                    break
                enrich.save_profile(lead["uid"], err=msg)
                say(f"  {who}: профиль не дался ({msg})")
                continue

            if not (prof.get("about") or posts or prof.get("business") or prof.get("birthday")):
                enrich.save_profile(lead["uid"], profile=prof)       # смотреть нечего — и это итог
                say(f"  {who}: профиль пустой")
            else:
                got = ask(lead, prof, posts)
                if got is None:
                    say(f"  модель недоступна ({llm.LAST_ERR or 'нет ответа'}) — продолжу позже")
                    stop = "errors"
                    break
                if got == "bad":
                    enrich.save_profile(lead["uid"], err="модель не дала ответа")
                    say(f"  {who}: модель ответила непонятно — позже")
                    continue
                seller, facts, note = got
                enrich.save_profile(lead["uid"], profile=prof, facts=facts, note=note,
                                    excluded="по профилю — сам продаёт или посредник" if seller else "")
                say(f"  {who}: " + ("✖ продавец/посредник — убрал из лидов" if seller
                                     else f"✔ фактов {len(facts)}" + (f", постов {len(posts)}" if posts else "")))
            done += 1
            if n < min(per_run, len(todo)) - 1:
                await asyncio.sleep(random.uniform(*PAUSE))
    finally:
        await tglib.aclose(client)
    left = len(enrich.profile_todo())
    say(f"\nитого: профилей посмотрено {done}, осталось {left}")
    if wait:
        tglib.state(done=done, left=left, stop="flood", cooldown=wait)
    else:
        tglib.state(done=done, left=left, stop=stop, cooldown=15 * 60 if stop else 0)


asyncio.run(main())
