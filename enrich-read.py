#!/usr/bin/env python3
"""
Читатель: один чат из очереди обогащения за запуск.

Берёт следующий свободный чат (enrich/chats.json), вступает, если надо,
выкачивает историю за 90 дней пачками по 100 с паузой 1–3 с и пишет её в
enrich/raw/<chat_id>.jsonl. Потом выходит из чата: у аккаунта потолок 500
чатов, а читать этот ему больше незачем. Разбор — уже не его дело
(enrich-analyze.py, без Telegram).

Читатель никому не пишет, не комментирует и не ставит реакций: жалобы и
заморозки достаются писателям, база с читателями не теряется.

У канала-вещалки читаем его группу обсуждения — это и есть комментарии.
Канал без комментариев пропускаем: людей там не видно.

Прервали посреди чата (флуд, падение) — файл остаётся, следующий заход этого
же читателя продолжит с самого старого уже прочитанного сообщения.

    python enrich-read.py --account r1
    python enrich-read.py --account r1 --days 30
"""
import asyncio
import contextlib
import json
import random
import signal
from datetime import datetime, timedelta, timezone

import enrich
import tglib
from chatlib import chat_ref, resolve_chat
from tglib import say

PAGE = 100
PAUSE = (1, 3)            # между запросами истории, сек
FLOOD_MAX = 600           # дольше этой флуд-паузы не сидим — отдаём чат обратно
JOIN_MAX = 20             # вступлений в сутки на читателя


def record(m):
    """Сообщение -> строка jsonl. None — читать нечего (служебное, пустое)."""
    from telethon.tl.types import User
    if getattr(m, "action", None) or not (m.message or "").strip():
        return None
    s = m.sender
    if isinstance(s, User):
        if s.bot:
            return None
        uid, un = s.id, s.username or ""
        name = " ".join(x for x in [s.first_name, s.last_name] if x)
    else:
        # пост канала в группе обсуждения или аноним-админ: для контекста
        # оставляем, автором для разбора не считаем (uid 0)
        uid, un, name = 0, getattr(s, "username", "") or "", getattr(s, "title", "") or "канал"
    reply = getattr(m, "reply_to", None)
    return {"id": m.id, "date": m.date.isoformat(timespec="seconds"), "uid": uid, "un": un,
            "name": tglib.cell(name), "text": m.message[:3000],
            "reply_to": getattr(reply, "reply_to_msg_id", None) or None}


def resume_point(path):
    """С какого id продолжать (самое старое прочитанное) и сколько уже есть."""
    oldest, n = 0, 0
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    i = json.loads(line)["id"]
                except Exception:
                    continue
                n += 1
                oldest = i if not oldest else min(oldest, i)
    except FileNotFoundError:
        pass
    return oldest, n


class JoinLimit(Exception):
    """Дневной предел вступлений выбран — чат ждёт завтрашнего захода."""


async def leave(client, entity):
    """Выйти из чата, в который вступили сами: у аккаунта потолок 500 чатов."""
    from telethon import functions
    from telethon.tl.types import Channel
    try:
        if isinstance(entity, Channel):
            await client(functions.channels.LeaveChannelRequest(entity))
        else:
            await client.delete_dialog(entity)       # старая маленькая группа
        say("  вышел из чата")
    except Exception as e:
        say(f"  выйти не вышло: {str(e).splitlines()[0][:80]}")


async def join(client, acc_id, joined, do):
    """Вступление под дневным пределом: считаем его и запоминаем, откуда потом выйти."""
    if enrich.joins_today(acc_id) >= JOIN_MAX:
        raise JoinLimit()
    entity = await do()
    enrich.note_join(acc_id)
    joined.append(entity)
    say("  вступил")
    await asyncio.sleep(random.uniform(3, 6))
    return entity


async def open_chat(client, ref, acc_id, joined):
    """
    Сущность для чтения: группа как есть, у канала — его обсуждение.
    Вступаем, только если не состоим, — и по ссылке-приглашению тоже: такое
    вступление считается в дневной предел, и из такого чата потом выходим.
    """
    from telethon import functions
    from telethon.tl.types import Channel, ChatInviteAlready, ChatInvitePeek

    r, invite = chat_ref(ref)
    if invite:
        res = await client(functions.messages.CheckChatInviteRequest(invite))
        if isinstance(res, (ChatInviteAlready, ChatInvitePeek)):
            entity = res.chat
        else:
            async def by_invite():
                upd = await client(functions.messages.ImportChatInviteRequest(invite))
                return upd.chats[0]
            entity = await join(client, acc_id, joined, by_invite)
    else:
        entity = await resolve_chat(client, r, None, join=False)
    head = entity
    if isinstance(entity, Channel) and entity.broadcast:
        full = await client(functions.channels.GetFullChannelRequest(entity))
        linked = getattr(full.full_chat, "linked_chat_id", None)
        if not linked:
            return head, None
        entity = next((c for c in full.chats if c.id == linked), None) or await client.get_entity(linked)
    # публичную группу можно читать и так, но читателю положено быть внутри —
    # так видна вся история
    if isinstance(entity, Channel) and getattr(entity, "left", False):
        async def by_join(ent=entity):
            await client(functions.channels.JoinChannelRequest(ent))
            return ent
        await join(client, acc_id, joined, by_join)
    return head, entity


async def read_chat(client, acc, key, ch, days, joined):
    """Один чат: открыть, выкачать в jsonl, отметить. Возвращает отчёт: (done, сообщение)."""
    from telethon.errors import FloodWaitError

    say(f"\n▸ {ch.get('title') or ch['ref']}")
    head, entity = await open_chat(client, ch["ref"], acc["id"], joined)
    title = tglib.cell(getattr(head, "title", "") or ch.get("title") or ch["ref"])
    if entity is None:
        enrich.set_chat(key, status="skipped", title=title, err="канал без комментариев")
        return 0, "канал без комментариев — людей не видно, пропускаю"

    dup = enrich.duplicate_of(key, entity.id)
    if dup:
        enrich.set_chat(key, status="skipped", title=title, chat_id=entity.id, err=f"тот же чат, что {dup}")
        return 0, f"это тот же чат, что уже в очереди ({dup}) — пропускаю"
    # read_ref — откуда сообщения на самом деле (у канала это его обсуждение):
    # по нему писатель потом найдёт сообщение лида
    enrich.set_chat(key, title=title, chat_id=entity.id, username=getattr(head, "username", "") or "",
                    read_ref=("@" + entity.username) if getattr(entity, "username", None) else "")

    path = enrich.raw_path(entity.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    offset, n = resume_point(path)
    if n:
        say(f"  продолжаю: уже прочитано {n}")
    since = datetime.now(timezone.utc) - timedelta(days=days)
    done_reading = False
    with path.open("a", encoding="utf-8") as out:
        while not done_reading:
            try:
                batch = await client.get_messages(entity, limit=PAGE, offset_id=offset)
            except FloodWaitError as e:
                if e.seconds > FLOOD_MAX:
                    enrich.set_chat(key, msgs=n)
                    raise                       # main вернёт чат в очередь: продолжим с этого места
                say(f"  … флуд-пауза {e.seconds} с")
                await asyncio.sleep(e.seconds)
                continue
            if not batch:
                break
            for m in batch:
                if m.date < since:
                    done_reading = True
                    break
                rec = record(m)
                if rec:
                    out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    n += 1
            out.flush()
            offset = batch[-1].id
            if len(batch) < PAGE:
                break
            if n and n % 1000 < PAGE:
                say(f"  прочитано {n} (до {batch[-1].date:%d.%m})")
                enrich.set_chat(key, msgs=n)       # заодно отметка «читатель жив»
            await asyncio.sleep(random.uniform(*PAUSE))

    enrich.set_chat(key, status="downloaded", msgs=n, read_at=enrich.now_iso())
    return 1, f"готово: сообщений за {days} дн. — {n}"


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    days = int(tglib.arg("days", 0) or 0) or enrich.DAYS
    say(f"аккаунт: {acc['title']}  |  читатель  |  {tglib.proxy_label(acc.get('proxy'))}")

    key, ch = enrich.pick_chat(acc["id"])
    if not key:
        say("в очереди нет чатов — добавь ссылки или найди чаты по ключевикам")
        tglib.state(done=0, left=0)
        return
    left_q = sum(1 for v in enrich.load_chats().values() if v.get("status") == "new")

    # Остановка из панели (SIGTERM) — отмена задачи: чат вернётся в очередь,
    # из вступленных чатов выйдем. Без этого он висел бы «читается» до 3 часов
    with contextlib.suppress(NotImplementedError, RuntimeError):     # Windows
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, asyncio.current_task().cancel)

    from telethon.errors import FloodWaitError

    try:
        client = await tglib.connect(acc)
    except (SystemExit, Exception) as e:
        # прокси, сеть, сессия — чат тут ни при чём, он ждёт следующего захода
        enrich.set_chat(key, status="new")
        say(f"не подключился: {str(e).splitlines()[0][:120] if str(e) else type(e).__name__}")
        tglib.state(done=0, left=left_q + 1, stop="errors", cooldown=10 * 60)
        return

    joined = []
    report = None
    try:
        done, msg = await read_chat(client, acc, key, ch, days, joined)
        say(f"  {msg}")
        report = dict(done=done, left=left_q)
    except JoinLimit:
        enrich.set_chat(key, status="new")
        say(f"  на сегодня вступлений уже {JOIN_MAX} — чат вернул в очередь, продолжу завтра")
        report = dict(done=0, left=left_q + 1, cooldown=tglib.until_tomorrow(), note="предел вступлений")
    except FloodWaitError as e:
        enrich.set_chat(key, status="new")
        say(f"  Telegram просит паузу {e.seconds} с — чат вернул в очередь, продолжу с этого места")
        report = dict(done=0, left=left_q + 1, stop="flood", cooldown=e.seconds)
    except asyncio.CancelledError:
        enrich.set_chat(key, status="new")
        say("  остановлен из панели — чат вернул в очередь")
    except (SystemExit, Exception) as e:
        # закрытый чат, заявка на вступление, потолок 500 чатов, выгнал антиспам…
        msg = str(e).splitlines()[0][:120] if str(e) else type(e).__name__
        enrich.set_chat(key, status="error", err=msg)
        say(f"  не вышло: {msg}")
        report = dict(done=0, left=left_q)
    finally:
        for ent in joined:
            await leave(client, ent)
        await tglib.aclose(client)
    if report:
        tglib.state(**report)


asyncio.run(main())
