#!/usr/bin/env python3
"""
Профиль лида: «о себе», день рождения, бизнес-данные и — если в профиле есть
личный канал — его последние 20 постов. Модель достаёт из этого факты для
будущего личного письма и заодно проверяет, не продавец ли это сам (риелтор,
агент, посредник): такого из лидов убираем.

Порциями, аккаунтом-читателем. Доступ к человеку — без вступлений:
  1) из сессии: этот читатель видел его сообщения, access_hash уже есть;
  2) через его сообщение в публичном чате (InputUserFromMessage), как пишет писатель;
  3) по @нику — последним: ResolveUsername у Telegram самый жадный до флуд-пауз,
     поэтому таких запросов за заход не больше RESOLVES.

Лида из закрытого чата без @ника видит только читатель, который этот чат
читал. Другой читатель такого не трогает и попытку ему не засчитывает —
дождётся «своего».

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
RESOLVES = 8              # запросов «по имени» (ник, публичный чат) за заход
LATER = "later"           # к человеку сейчас не подступиться не по его вине — без попытки

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


def public_chats(lead):
    """Публичные чаты лида с id его сообщений: (ссылка, [id…]). Инвайты — мимо."""
    out = []
    for ch in reversed(lead.get("chats") or []):
        ids = [int(i) for i in (ch.get("msg_ids") or [])][-5:]
        r, invite = chat_ref(ch.get("ref") or "") if ch.get("ref") else (None, None)
        if ids and r and not invite:
            out.append((r, ids))
    return out


async def input_user(client, lead, budget):
    """
    Доступ к человеку для GetFullUser: сперва кеш сессии (читатель видел его
    сообщения), потом его сообщение в публичном чате, ник — последним.
    budget["resolves"] — сколько ещё запросов «по имени» можно в этом заходе;
    кончились — LATER: человек подождёт следующего захода, попытка не в счёт.
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
    later = False
    for r, ids in public_chats(lead):
        if budget["resolves"] <= 0:
            later = True
            break
        budget["resolves"] -= 1
        try:
            peer = await client.get_input_entity(r)
            for m in await client.get_messages(peer, ids=ids):
                if m is not None and m.sender_id == uid:
                    return InputUserFromMessage(peer=peer, msg_id=m.id, user_id=uid)
        except FloodWaitError:
            raise
        except Exception:
            continue                                # сообщение удалили, чат закрыли
    if lead.get("username"):
        if budget["resolves"] <= 0:
            return LATER
        budget["resolves"] -= 1
        try:
            p = await client.get_input_entity("@" + lead["username"])
            if isinstance(p, InputPeerUser) and p.user_id == uid:
                return InputUser(p.user_id, p.access_hash)
        except FloodWaitError:
            raise
        except Exception:
            pass                                    # ник сменили
    return LATER if later else None


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


_DEC = json.JSONDecoder(strict=False)     # заметку модели пишут с переносами строк прямо в JSON


def _parse(out, final):
    """(seller, facts, note) из ответа: последний объект с "seller". Обрезан —
    на последней попытке спасаем хотя бы сам вердикт «продавец или нет»."""
    starts = list(re.finditer(r'\{\s*"seller"\s*:\s*(true|false)\b(?!\s*\|)', out or ""))
    if not starts:
        return None
    m = starts[-1]
    try:
        d, _ = _DEC.raw_decode(out, m.start())
    except ValueError:
        return (m.group(1) == "true", {}, "") if final else None
    if not isinstance(d, dict):
        return None
    facts = {}
    for k, v in (d.get("facts") or {}).items() if isinstance(d.get("facts"), dict) else []:
        k, v = " ".join(str(k).split())[:40], " ".join(str(v).split())[:300]
        if k and v:
            facts[k] = v
    return bool(d.get("seller") is True or str(d.get("seller")).lower() == "true"), facts, str(d.get("note") or "")


def refused(code):
    """Модель отказала именно в этом запросе (длинно, не понравился текст), а не лежит."""
    err = (llm.LAST_ERR or "").lower()
    return code in ("400", "413") or "content exists risk" in err or (
        code == "403" and ("moderation" in err or "flagged" in err))


def ask(lead, prof, posts):
    """
    (seller, facts, note), или:
      None   — модель недоступна (сеть, деньги, ключ): остановимся, повторим позже;
      "req"  — отказала в запросе по этому человеку (его посты, длина);
      "bad"  — ответила, но без вердикта и после повтора с запасом токенов.
    """
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
    text = PROMPT.format(goal=enrich.goal(), why=why, chan=chan, body="\n".join(body)[:9000])
    budgets = (1200, 2500)
    for n, tokens in enumerate(budgets):
        info = {}
        out = llm.chat("Отвечай строго в формате, который просят.", text,
                       max_tokens=tokens, temperature=0.2, info=info)
        if out is None:
            return "req" if refused(str(info.get("code", ""))) else None
        got = _parse(out, final=n == len(budgets) - 1)
        if got:
            return got
    return "bad"


def model_alive():
    """Жива ли модель вообще — тот же запас токенов, что у настоящего запроса."""
    return llm.chat("Ответь одним словом.", "ок", max_tokens=900, temperature=0, info={}) is not None


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
    owners = lambda l: {readers.get(str(c.get("chat_id"))) for c in l.get("chats") or []} - {None, ""}
    mine = lambda l: acc["id"] in owners(l)
    # живые читатели: их лидов из закрытых чатов не трогаем — у них доступ есть, у нас нет
    alive = {a["id"] for a in tglib.load_accounts() if a.get("role") == "read" and not a.get("retired")
             and a.get("spamKind") not in ("frozen", "perm")}
    theirs = lambda l: not mine(l) and bool(owners(l) & alive)
    reachable = lambda l: bool(l.get("username") or public_chats(l))
    todo = [l for l in todo if not theirs(l) or reachable(l)]
    todo.sort(key=lambda l: not mine(l))
    if not todo:
        say("остались лиды из закрытых чатов других читателей — их профили посмотрят они")
        tglib.state(done=0, left=len(enrich.profile_todo()))
        return
    say(f"профилей к просмотру: {len(todo)}, за этот заход до {per_run}")

    client = await tglib.connect(acc)
    done = 0
    stop, wait = "", 0
    budget = {"resolves": RESOLVES}
    answered = False                  # модель в этом заходе уже отвечала — значит, жива
    try:
        for n, lead in enumerate(todo[:per_run]):
            who = f"@{lead['username']}" if lead.get("username") else f"id{lead['uid']} ({lead.get('name', '')})"
            try:
                iu = await input_user(client, lead, budget)
                if iu is LATER:
                    say(f"  {who}: на этот заход запросов по имени хватит — в следующий раз")
                    continue
                if iu is None:
                    if theirs(lead):
                        say(f"  {who}: доступ к нему у читателя, который читал его чат, — оставлю ему")
                        continue
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
                if got == "req" and not answered and not model_alive():
                    got = None                # отказ на всё подряд (неверная модель, ключ) — это простой
                if got is None:
                    say(f"  модель недоступна ({llm.LAST_ERR or 'нет ответа'}) — продолжу позже")
                    stop = "errors"
                    break
                answered = True
                if got == "req":
                    enrich.save_profile(lead["uid"], err=f"модель отказала: {(llm.LAST_ERR or '')[:80]}")
                    say(f"  {who}: модель отказалась разбирать его профиль ({llm.LAST_ERR or 'отказ'}) — дальше")
                    continue
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
