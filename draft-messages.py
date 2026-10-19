#!/usr/bin/env python3
"""
Раскладывает черновики (или отправляет сообщения) найденным в Telegram
людям — родным каналом, без браузера. Замена draft-messages.mjs.

Получатель бывает двух видов, и оба лежат в одной очереди (results.csv):
номер, который прошёл проверку, и человек из разбора чата — у него вместо
номера @username или id (см. «Ключ получателя» в tglib.py).

Для номера: добавить контакт -> положить текст черновиком в чат -> убедиться,
что черновик на месте -> [--send: отправить] -> удалить контакт из адресной
книги. Человека из чата искать по номеру не нужно и в контакты класть нечего —
шаг с адресной книгой просто пропускается. Чат с черновиком остаётся,
отправляешь сам.

Без --send получателю не уходит ни сообщение, ни уведомление — это режим
по умолчанию, и он безопасный. С --send сообщение уходит, отозвать нельзя.

Ритм намеренно медленный, и это главное в рассылке по номерам:
  • контакт заводится ПО ОДНОМУ — пакетный импорт Telegram не прощает;
  • между «завёл контакт» и «написал» пауза 60–120 секунд: живой человек
    не пишет в ту же секунду, как увидел номер в книжке;
  • между людьми 180–350 секунд;
  • контакт удаляется сразу после отправки, а забытые с прошлых сбоев
    подчищаются в начале захода.

    python draft-messages.py --account a1 --limit 2
    python draft-messages.py --account a1 --limit 2 --send
    python draft-messages.py --account a1 --hold 60 --hold-max 120 --delay 180 --delay-max 350
"""
import asyncio
import atexit
import random
import re
import signal
import sys
from datetime import datetime, timezone

import claims
import tglib
from tglib import say

FLOOD_MAX = 600
HOLD_MIN, HOLD_MAX = 60, 120   # пауза между «завёл контакт» и «написал», сек
DELAY_MIN, DELAY_MAX = 180, 350  # пауза между людьми, сек
MAX_TRIES = 3                  # столько раз номер не дался — больше не берём
MAX_FAILS_IN_ROW = 3           # столько сбоев подряд — пачку пора прекращать
COOLDOWN_FLOOD = 12 * 3600     # после PEER_FLOOD на рассылке — отдых подольше
COOLDOWN_ERRORS = 15 * 60
COOLDOWN_TEXT = 30 * 60        # ошибка в тексте письма: ждём, пока поправят в панели


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def extras_for(extras, row):
    """Строка из таблицы кастомных полей (extras.csv) для этого человека, или {}."""
    key = (row.get("phone") or "").strip()
    user = row.get("username") or ""
    return (extras.get(key) or extras.get(key.lstrip("@"))
            or extras.get("@" + user) or extras.get(user) or {})


def compose(tpl, row, extras=None, extra_cols=None):
    """
    Текст письма для конкретного человека.

    Сначала разворачиваем варианты {так|или так} — на каждого свой выбор,
    чтобы письма не повторялись слово в слово. Потом подстановки: имя, дата
    звонка, @username, ссылка-зеркало. У людей из разбора чата даты звонка
    нет — подстановка {date} у них просто пустая.

    extras/extra_cols — кастомные колонки из таблицы пользователя (extras.csv):
    {brand}, {lpr} и любые другие. Нет значения у человека — подставляется пусто.
    """
    tpl = tglib.spin(tpl)
    first = (row.get("name") or "").split(" ")[0].strip()
    name = f", {first}" if first else ""
    date = ".".join(reversed((row.get("last_call") or "")[:10].split("-")))
    user = row.get("username") or ""
    link = tglib.current_link()
    # {chat} — где нашли человека (только у собранных из чатов)
    tpl = tpl.replace("{chat}", row.get("chat") or "")
    out = (tpl.replace("{name}", name).replace("{date}", date)
              .replace("{username}", f"@{user}" if user else "")
              .replace("{LINK}", link).replace("{link}", link))
    if extras and extra_cols:
        ex = extras_for(extras, row)
        for c in extra_cols:
            out = out.replace("{" + c + "}", ex.get(c, ""))
    return out


async def find_member(client, key, acc):
    """
    Человек из разбора чата. @username Telegram развернёт кому угодно, а голый
    id — только тому аккаунту, который этого человека уже видел: access_hash
    лежит в его сессии. Поэтому у собранных без @username получатель ровно
    один — аккаунт-сборщик, и об этом надо сказать словами, а не молчаливым
    «не найден».

    Исключение — лид обогащения: у него сохранены чат и сообщения. Не вышло по
    ключу (нет ника, ник сменили) — идём через сообщение (via_message).
    """
    lead = tglib.lead_refs().get(key)
    try:
        if key.startswith("@"):
            return await client.get_entity(key)
        return await client.get_entity(int(key[3:]))
    except ValueError:
        if lead:
            return await via_message(client, lead, acc)
        raise ValueError("у человека нет @username — писать ему может только "
                         "тот аккаунт, который разбирал чат")


WRITER_JOINS = 3     # вступлений в закрытые чаты лидов в сутки на писателя


async def via_message(client, lead, acc):
    """
    Доступ к лиду через его сообщение в чате. Читатель видел человека, а
    писатель — нет: access_hash у каждого аккаунта свой. Поэтому писатель
    открывает тот же чат (публичный — без вступления), находит сообщение лида
    и спрашивает человека «из этого сообщения» (InputUserFromMessage) — так
    Telegram отдаёт полноценный профиль, которому можно писать.
    """
    import enrich
    from chatlib import chat_ref, resolve_chat
    from telethon import functions
    from telethon.tl.types import InputUserFromMessage, UserEmpty

    uid = int(lead.get("uid"))
    why = "сообщений лида в чатах больше нет"
    for ch in reversed(lead.get("chats") or []):          # свежий чат — первым
        ids = [int(i) for i in (ch.get("msg_ids") or [])][-10:]
        if not ids or not ch.get("ref"):
            continue
        try:
            ref, invite = chat_ref(ch["ref"])
            if invite:
                if enrich.joins_today(acc["id"]) >= WRITER_JOINS:
                    why = f"чат лида закрытый, а вступлений на сегодня уже {WRITER_JOINS}"
                    continue
                entity = await resolve_chat(client, None, invite, join=True)
                enrich.note_join(acc["id"])
            else:
                entity = await client.get_entity(ref)
            peer = await client.get_input_entity(entity)
            for m in await client.get_messages(entity, ids=ids):
                if m is None or m.sender_id != uid:
                    continue
                got = await client(functions.users.GetUsersRequest(
                    [InputUserFromMessage(peer=peer, msg_id=m.id, user_id=uid)]))
                if got and not isinstance(got[0], UserEmpty):
                    return got[0]
        except (ValueError, SystemExit) as e:
            why = str(e).splitlines()[0][:100] or why
    raise ValueError(f"не вышло найти лида через его сообщение: {why}")


CONTACT_LABEL = re.compile(r"^\d{10}$")


def digits(phone):
    return "".join(ch for ch in str(phone or "") if ch.isdigit())


async def sweep_contacts(client, keep=frozenset()):
    """
    Убрать из адресной книги контакты, оставшиеся с прошлых заходов.

    Обычно чистить нечего: контакт удаляется сразу после отправки. Но если
    процесс упал между «добавил» и «удалил», номер остался в книжке — а книжка,
    набитая чужими номерами, это ровно та примета, по которой аккаунт и ловят.
    Поэтому подметаем в начале каждого захода, а не только руками по кнопке.

    keep — номера (цифрами), которые проверка оставила в контактах нарочно:
    они ждут письма от этого аккаунта, их не трогаем.
    """
    from telethon import functions
    try:
        res = await client(functions.contacts.GetContactsRequest(hash=0))
    except Exception:
        return 0
    stale = [u for u in getattr(res, "users", [])
             if CONTACT_LABEL.match((u.first_name or "").strip())
             and not (u.last_name or "").strip()
             and digits(u.phone) not in keep]
    if not stale:
        return 0
    try:
        await client(functions.contacts.DeleteContactsRequest(id=[u.id for u in stale]))
    except Exception:
        return 0
    return len(stale)


async def saved_draft(client, user):
    """Текст черновика, который сейчас лежит в чате с этим человеком."""
    from telethon import functions
    from telethon.tl.types import UpdateDraftMessage, DraftMessage
    res = await client(functions.messages.GetAllDraftsRequest())
    for upd in getattr(res, "updates", []):
        if not isinstance(upd, UpdateDraftMessage):
            continue
        peer_id = getattr(upd.peer, "user_id", None)
        if peer_id == user.id and isinstance(upd.draft, DraftMessage):
            return upd.draft.message or ""
    return ""


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    limit = int(tglib.arg("limit", 2))
    delay = float(tglib.arg("delay", DELAY_MIN))
    delay_max = float(tglib.arg("delay-max", max(delay, DELAY_MAX)))
    hold = float(tglib.arg("hold", HOLD_MIN))
    hold_max = float(tglib.arg("hold-max", max(hold, HOLD_MAX)))
    send = tglib.flag("send")
    voice = tglib.flag("voice")
    # панель ставит, когда аккаунты пишут параллельно с одного IP: тогда письма
    # разных аккаунтов разводим по времени (tglib.wait_send_gap)
    send_gap = tglib.flag("send-gap")
    # «Написать лидам»: из очереди по чатам — только лиды обогащения (leads.json)
    leads_only = tglib.flag("leads-only")

    # отдых после заморозки — людям не пишем вовсе, даже если роль в панели
    # переключили обратно в рассылку. Ни подключения, ни брони адресатов
    # (не `hold` — это пауза «завёл контакт → написал» из --hold выше)
    rest = tglib.send_hold_left(acc)
    if rest > 0:
        say(f"«{acc['title']}» на отдыхе после заморозки ещё "
            f"{rest // 3600} ч {rest % 3600 // 60} мин — людям не пишет")
        tglib.state(done=0, left=0, stop="hold", cooldown=rest, note="отдых после заморозки")
        return

    from telethon import functions
    from telethon.tl.types import InputPhoneContact, DocumentAttributeAudio
    from telethon.errors import FloodWaitError, PeerFloodError

    # голосовое нельзя положить черновиком — оно уходит сразу, поэтому это
    # всегда режим отправки, и файл должен уже лежать (кладёт панель)
    if voice and not tglib.VOICE.exists():
        say("нет голосового файла — загрузи его в панели (шаг 4)")
        raise SystemExit(1)
    voice_dur = tglib.voice_duration() if voice else 0

    mode = "ГОЛОСОВОЕ" if voice else "РЕЖИМ ОТПРАВКИ" if send else "только черновики"
    say(f"аккаунт: {acc['title']}  |  {mode}"
        f"  |  {tglib.proxy_label(acc.get('proxy'))}  |  Telethon")
    if send_gap and (send or voice):
        say("параллель на общем IP — письма разных аккаунтов развожу по времени")

    moved = tglib.migrate_drafts_log()
    if moved:
        say(f"лог черновиков переведён на новый формат ({moved} строк)")

    # сборный текст важнее одиночного: включили блоки — значит, письма должны
    # общий текст может вовсе отсутствовать (кампания только «по чатам» — у неё
    # свой message-chat.txt). Тогда tpl пустой, а собранным из чатов уйдёт их текст.
    tpl = tglib.MESSAGE.read_text("utf-8").strip() if tglib.MESSAGE.exists() else ""
    tpl = tglib.fix_placeholders(tpl)
    n = tglib.spin_count(tpl)
    if n > 1:
        say(f"в тексте варианты: до {n} непохожих писем")
    # отдельный текст для собранных ИЗ ЧАТОВ (у них нет номера). Пусто — все
    # получают общий текст, как раньше
    tpl_chat = ""
    try:
        if tglib.MESSAGE_CHAT.exists():
            tpl_chat = tglib.fix_placeholders(tglib.MESSAGE_CHAT.read_text("utf-8").strip())
    except Exception:
        pass
    if tpl_chat:
        say("для собранных из чатов — отдельный текст (база из файла получает свой)")
    # кастомные поля из таблицы ({brand}, {lpr}…) — extras.csv рядом с данными
    extras, extra_cols = tglib.extras_of()
    if extra_cols:
        say(f"кастомные поля для подстановки: {', '.join('{' + c + '}' for c in sorted(extra_cols))}")
    # запасной текст для чатов — тем, у кого нет полей таблицы для основного
    tpl_plain = ""
    if tglib.MESSAGE_CHAT_PLAIN.exists():
        tpl_plain = tglib.fix_placeholders(tglib.MESSAGE_CHAT_PLAIN.read_text("utf-8").strip())
    # колонки таблицы, на которых держится текст для чатов ({brand}…): нет их у
    # человека — уходит запасной текст, а нет и его — такому не пишем вовсе,
    # чтобы не ушло «Нашёл  на маркетплейсе» с дыркой вместо бренда
    need_cols = [c for c in (extra_cols or ()) if "{" + c + "}" in tpl_chat]

    def pick_tpl(row):
        """Какой текст уйдёт этому человеку; \"\" — писать ему нечем."""
        if not (tpl_chat and not tglib.is_phone(row["phone"])):
            return tpl
        if need_cols:
            ex = extras_for(extras, row)
            if not all(ex.get(c) for c in need_cols):
                return tpl_plain
        return tpl_chat

    # название чата, где нашли человека, — для подстановки {chat}
    uses_chat = any("{chat}" in t for t in (tpl_chat or tpl, tpl_plain))
    chat_of = tglib.chat_of_members() if uses_chat else {}
    if uses_chat:
        # лиды обогащения в members.csv не попадают — чат берём из их карточки
        # (последний, где человек показал интерес)
        for k, lead in tglib.lead_refs().items():
            title = ((lead.get("chats") or [{}])[-1].get("title") or "").strip()
            if title and not chat_of.get(k):
                chat_of[k] = title

    # одному человеку пишем один раз — с любого из аккаунтов. Неудачные попытки
    # (ok=false) не считаются: до них дело не дошло, номер вернётся в очередь.
    # Голосовое учитываем тоже: уже написанному или озвученному повторно не шлём.
    log = tglib.read_csv(tglib.DRAFTS)
    # skip — давно не заходил в Telegram: решено навсегда, как и «написали»
    already = {r["phone"] for r in log
               if r.get("ok") in ("true", "skip") or r.get("sent") == "true"}
    # номер, который не вышло обработать MAX_TRIES раз, откладываем: иначе
    # автопрогон брал бы его снова и снова и стоял бы на месте
    tries = tglib.tries_by_phone(log, already)
    queue = [r for r in tglib.read_csv(tglib.RESULTS)
             if r.get("tg") == "true" and r["phone"] not in already
             and tries.get(r["phone"], 0) < MAX_TRIES
             and tglib.can_write(r, acc["id"])
             and (not leads_only or r["phone"] in tglib.lead_refs())]
    if leads_only:
        say(f"пишем только лидам: в очереди {len(queue)}")
    nothing = sum(1 for r in queue if not pick_tpl(r))
    if nothing:
        say(f"без текста (нет бренда и нет запасного текста для чатов): {nothing} — им не пишу")
        queue = [r for r in queue if pick_tpl(r)]
    # сначала — те, кого этот аккаунт сам нашёл и держит в контактах: им писать
    # без новой траты квоты, и держать их в книжке дольше незачем
    # дальше — люди из самых близких к теме чатов (ипотека, недвижимость,
    # инвестиции), потом из чатов ЖК, остальное — в конце (chat-priority.txt)
    rank, chat_of_all = tglib.chat_rank_fn(), tglib.chat_of_members() if tglib.SET == "chats" else {}
    # самые первые — из списка «писать в первую очередь» (queue-first.txt), в его порядке
    first = tglib.queue_first()
    queue.sort(key=lambda r: (first.get(r["phone"].lower(), len(first)),
                              not (r.get("kept") == "1" and r.get("by") == acc["id"]),
                              rank(chat_of_all.get(r["phone"], "")) if chat_of_all else 0))
    mine = set(claims.take(acc["id"], "draft", [r["phone"] for r in queue], limit))
    todo = [r for r in queue if r["phone"] in mine]

    atexit.register(lambda: claims.release_all(acc["id"], "draft"))
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: sys.exit(1))

    tglib.ensure_head(tglib.DRAFTS, tglib.DRAFTS_HEAD)
    say(f"черновиков к раскладке: {len(todo)}")
    if not todo:
        tglib.state(done=0, left=len(queue))
        return

    # Подстановку, которой рассылка не знает, человек получил бы как есть — с
    # фигурными скобками. Такой текст не шлём вовсе: проверяем те шаблоны, что
    # уйдут в этот заход, до подключения к Telegram
    used = {pick_tpl(r) for r in todo}
    bad = sorted({b for t in used for b in tglib.bad_placeholders(t, tglib.PH_KNOWN + tuple(extra_cols or ()))})
    if bad:
        say("стоп: в тексте письма непонятные подстановки: " + ", ".join(bad) +
            " — не отправляю. Поправь текст в панели: понимаю {name}, {date}, {username}, "
            "{chat}, {LINK} и колонки таблицы")
        tglib.state(done=0, left=len(queue), stop="text", cooldown=COOLDOWN_TEXT,
                    note="ошибка в тексте письма")
        return

    client = await tglib.connect(acc)
    say(f"сессия активна: {tglib.who(acc)}")

    # Спрашиваем @SpamBot ДО первого сообщения. Ограничение видно только так:
    # Telegram не отвечает ошибкой на отправку, он просто перестаёт доносить
    # сообщения — аккаунт пишет в пустоту, а панель считает это успехом.
    ok, note = await tglib.spam_check(client, acc, force=True)
    if ok is None:
        say(f"@SpamBot не ответил ({note}) — иду по прошлому вердикту")
    elif not ok:
        say(f"\n@SpamBot: {note}")
        say("стоп: на аккаунте ограничение — в рассылку он не идёт, база остаётся на месте")
        await tglib.aclose(client)
        tglib.state(done=0, left=len(queue), stop="quarantine",
                    cooldown=tglib.until_tomorrow(), note="карантин")
        return
    else:
        say(f"@SpamBot: {note}")
        # бот только что сказал «свободен» после ограничения — spam_check
        # поставил отдых без рассылки, в этот заход тоже не пишем
        rest = tglib.send_hold_left(acc)
        if rest > 0:
            say(f"ограничение сняли, но сразу писать не иду: ещё {rest // 3600} ч "
                f"{rest % 3600 // 60} мин без рассылки, потом разгон с 2 писем в день")
            await tglib.aclose(client)
            tglib.state(done=0, left=len(queue), stop="hold", cooldown=rest,
                        note="отдых после ограничения")
            return

    # кого проверка оставила в контактах этого аккаунта и кому ещё не писали
    keep = tglib.kept_waiting(acc["id"])
    swept = await sweep_contacts(client, keep)
    if swept:
        say(f"убрал из адресной книги забытых контактов: {swept}")
    # сами эти контакты — чтобы писать им без повторного «добавить в контакты»
    saved = {}
    if keep:
        try:
            got = await client(functions.contacts.GetContactsRequest(hash=0))
            saved = {digits(u.phone): u for u in getattr(got, "users", []) if u.phone}
        except Exception:
            saved = {}
    # папка «Рассылка» — все, кому писал этот аккаунт; без неё рассылку не
    # останавливаем: это удобство для человека, а не условие работы
    try:
        if await tglib.ensure_outreach_folder(client, acc):
            say(f"завёл в аккаунте папку «{tglib.OUTREACH_FOLDER}» — все, кому он пишет")
    except Exception as e:
        say(f"папку «{tglib.OUTREACH_FOLDER}» завести не вышло: {str(e).splitlines()[0][:80]}")

    ok_n = sent_n = 0
    fails_row = 0            # сбои подряд: дальше давить бессмысленно
    quota_miss = 0           # подряд не прошедшие контакты — признак кончившейся квоты
    stop, cooldown = "", 0   # чем кончилась пачка — это читает автопрогон
    seen_phones = set()      # кому уже писали в ЭТОМ прогоне (защита от дублей строк)
    try:
        for i, row in enumerate(todo):
            phone = row["phone"]                      # ключ: номер, @username или id:
            label = phone[-10:] if tglib.is_phone(phone) else phone
            # база из xlsx (номер) — общий текст; собранные из чатов — свой, если задан
            use_tpl = pick_tpl(row)
            text = ""
            good, sent_flag = False, ""
            imported = False          # клали ли контакт в адресную книгу
            record = True             # писать ли строку в drafts.csv (в finally)
            user = None
            # дедуп в рамках прогона: одна и та же строка (дубль из results.csv при
            # параллельном разборе) не должна уйти человеку дважды
            if phone in seen_phones:
                continue
            seen_phones.add(phone)
            try:
                if not tglib.is_phone(phone):
                    # человек из разбора чата: адресная книга не нужна вовсе
                    user = await find_member(client, phone, acc)
                    quota_miss = 0
                elif digits(phone) in saved:
                    # проверка этого же аккаунта оставила его в контактах:
                    # пишем сразу, квоту на добавление второй раз не тратим.
                    # После письма контакт уберём, как и добавленный сейчас
                    user, imported = saved[digits(phone)], True
                    say(f"[{i + 1}/{len(todo)}] {phone} — уже в контактах с проверки")
                else:
                    res = await client(functions.contacts.ImportContactsRequest(
                        [InputPhoneContact(client_id=random.randrange(-2**62, 2**62),
                                           phone=phone, first_name=label, last_name="")]))
                    if not res.users:
                        # Этот номер УЖЕ отмечен «есть в Telegram» на проверке, значит
                        # пустой ответ — не «его нет», а кончившаяся квота на контакты.
                        # Записать его как неудачу нельзя: три такие попытки выкинули бы
                        # живого человека из базы навсегда. Оставляем номер в очереди.
                        quota_miss += 1
                        say(f"[{i + 1}/{len(todo)}] {phone} — контакт не прошёл "
                            f"(похоже, кончилась квота); номер остаётся в очереди")
                        if quota_miss >= 2:
                            say("\nстоп: квота на контакты кончилась — продолжим завтра")
                            stop, cooldown = "quota", tglib.until_tomorrow()
                            record = False
                            break
                        record = False   # без записи в drafts.csv: попытка не считается
                        continue
                    quota_miss = 0
                    user, imported = res.users[0], True

                # давно не заходил — письмо не прочтут, а непрочитанные письма
                # незнакомцам портят аккаунту репутацию. Решаем до паузы «жду
                # перед сообщением», чтобы не тратить на такого минуты
                if tglib.long_gone(user):
                    if imported:
                        await client(functions.contacts.DeleteContactsRequest(id=[user.id]))
                    good = "skip"
                    say(f"[{i + 1}/{len(todo)}] {phone} — пропуск: давно не заходил в Telegram")
                    continue

                # Имя для {name}: пока человек в контактах, Telegram отдаёт нашу
                # метку, а не его имя. Поэтому контакт убираем ДО письма (после
                # всё равно убирали), и только потом спрашиваем настоящее имя.
                # Писать дальше можно и так — доступ к человеку уже есть
                if imported:
                    await client(functions.contacts.DeleteContactsRequest(id=[user.id]))
                    imported = False
                row = {**row, "name": await tglib.real_name(client, user) if tglib.is_phone(phone)
                       else tglib.human_name(row.get("name")),
                       "chat": chat_of.get(phone, "")}
                if "{chat}" in use_tpl and not row["chat"]:
                    # без названия чата фраза «увидел вас в чате «»» выдала бы бота
                    good = False
                    say(f"[{i + 1}/{len(todo)}] {phone} — не знаю, в каком чате нашли; пропускаю")
                    record = False
                    continue
                text = compose(use_tpl, row, extras, extra_cols)
                # последний рубеж: скобки в готовом письме (странное значение в
                # таблице и т.п.) — человеку такое не уходит
                if "{" in text or "}" in text:
                    say(f"[{i + 1}/{len(todo)}] {phone} — в готовом письме фигурные скобки, "
                        f"не отправляю: «{' '.join(text.split())[:80]}»")
                    record = False
                    if imported:
                        await client(functions.contacts.DeleteContactsRequest(id=[user.id]))
                        imported = False
                    stop, cooldown = "text", COOLDOWN_TEXT
                    break

                if tglib.is_phone(phone) and digits(phone) not in saved:
                    # живой человек не пишет в ту же секунду, как занёс номер
                    # в книжку. Эта пауза — самая важная во всей рассылке
                    wait = random.uniform(hold, hold_max)
                    say(f"[{i + 1}/{len(todo)}] {phone} — контакт заведён, "
                        f"жду {wait:.0f} с перед сообщением")
                    await asyncio.sleep(wait)

                if send_gap and (send or voice):
                    # параллель на общем IP: не писать впритык к соседнему
                    # аккаунту. Разнос — четверть-половина своей паузы
                    waited = await tglib.wait_send_gap(
                        acc, max(30.0, delay * 0.25), max(45.0, delay * 0.5))
                    if waited >= 1:
                        say(f"[{i + 1}/{len(todo)}] {phone} — с этого IP только что "
                            f"писал другой аккаунт, подождал {waited:.0f} с")

                if voice:
                    # голосовая заметка — «кружок» с микрофоном, а не файл-аудио:
                    # это даёт voice=True в атрибутах; длительность берём из панели,
                    # иначе полоска показала бы 0:00
                    await client.send_file(
                        user, str(tglib.VOICE), voice_note=True,
                        attributes=[DocumentAttributeAudio(duration=voice_dur, voice=True)])
                    good, sent_flag = True, "true"
                    ok_n, sent_n = ok_n + 1, sent_n + 1
                    say(f"[{i + 1}/{len(todo)}] {phone} — голосовое отправлено ({voice_dur}с)")
                else:
                    await client(functions.messages.SaveDraftRequest(peer=user, message=text))
                    back = await saved_draft(client, user)
                    good = bool(back) and back.split("\n")[0][:20] in text
                    say(f"[{i + 1}/{len(todo)}] {phone} — черновик "
                        f"{'на месте' if good else 'НЕ сохранился'}")
                    if good:
                        ok_n += 1

                    if good and send:
                        # link_preview=False: превью растягивает письмо картинкой
                        # с чужого сайта и делает его заметным — и человеку,
                        # и Telegram. Деловое сообщение выглядит текстом
                        await client.send_message(user, text, link_preview=False)
                        # фиксируем «отправлено» СРАЗУ: если следующий шаг (очистка
                        # черновика/контакта) упадёт с PeerFlood, сообщение уже ушло —
                        # и в логе оно должно остаться sent, иначе будет повтор
                        sent_flag, sent_n = "true", sent_n + 1
                        # отправленное письмо не должно остаться ещё и черновиком
                        await client(functions.messages.SaveDraftRequest(peer=user, message=""))
                        # в журнал — весь текст целиком и с пометкой, кому он ушёл:
                        # при сборке из блоков каждому уходит своё, и «примерно
                        # такое» тут не годится
                        say(f"    отправлено {phone}: «{' '.join(text.split())}»")

                # чат остаётся, из адресной книги контакт убираем — но только
                # если сами его туда и положили: человека из чата мы в контакты
                # не добавляли, и удалять у него нечего
                if imported:
                    await client(functions.contacts.DeleteContactsRequest(id=[user.id]))
                fails_row = 0
            except FloodWaitError as e:
                say(f"[{i + 1}/{len(todo)}] {phone} — флуд-пауза {e.seconds} с")
                if e.seconds > FLOOD_MAX:
                    say("стоп: Telegram просит слишком долгую паузу — на сегодня хватит")
                    stop, cooldown = "flood", e.seconds
                    break
                await asyncio.sleep(e.seconds)
                fails_row += 1
            except PeerFloodError:
                say("\nстоп: аккаунт ограничен Telegram за рассылку (PEER_FLOOD).")
                say("  Продолжать нельзя — дай ему отлежаться или работай другим аккаунтом.")
                stop, cooldown = "flood", COOLDOWN_FLOOD
                break
            except Exception as e:
                msg = str(e).splitlines()[0][:120] if str(e) else type(e).__name__
                # Заморозка (блокировка по жалобам/ToS) всплывает как RPC-ошибка с
                # FROZEN_* — это не временный сбой, дальше писать нечем. Снимаем акк
                # сразу: помечаем frozen и уходим в карантин, чтобы панель не слала
                # в пустоту и показала заморозку, а не ждала следующего опроса SpamBot.
                if tglib.is_frozen_error(e):
                    say("\nстоп: аккаунт заморожен Telegram (блокировка по жалобам/ToS).")
                    say("  Писать с него нельзя — нужен разбан через @SpamBot/поддержку.")
                    tglib.set_field(acc["id"], spamKind="frozen", spamOk=False,
                                    spamUntil="", spamAt=now_iso(),
                                    spam=tglib.cell("заморожен — блокировка по жалобам (ToS), "
                                                    "снимается только разбаном через @SpamBot/поддержку"))
                    stop, cooldown = "quarantine", 0
                    break
                say(f"[{i + 1}/{len(todo)}] {phone} — {msg}")
                fails_row += 1
            finally:
                # пишем ИТОГ строкой ВСЕГДА (даже если дальше break по флуду) — иначе
                # уже отправленное сообщение не попадёт в лог и уйдёт человеку повторно
                if record:
                    tglib.append_row(tglib.DRAFTS,
                                     [phone, acc["id"], str(good).lower(), sent_flag, now_iso()],
                                     tglib.DRAFTS_HEAD)
                # id того, кому ушло: по ключу из базы проверка ответов человека
                # не всегда узнает — ник бывает в другом регистре или сменён,
                # а номер у удалённого из контактов скрыт
                if sent_flag == "true" and getattr(user, "id", None):
                    tglib.append_row(tglib.SENT_IDS, [phone, str(user.id), acc["id"], now_iso()],
                                     tglib.SENT_IDS_HEAD)
            # бронь держим до конца прогона (release_all в atexit): досрочное
            # снятие под параллельной рассылкой давало повтор одному человеку
            if fails_row >= MAX_FAILS_IN_ROW:
                say(f"\nстоп: {MAX_FAILS_IN_ROW} сбоя подряд — аккаунту нужна передышка")
                stop, cooldown = "errors", COOLDOWN_ERRORS
                break
            if i < len(todo) - 1:
                wait = random.uniform(delay, max(delay, delay_max))
                say(f"    пауза {wait:.0f} с до следующего")
                await asyncio.sleep(wait)
    finally:
        await tglib.aclose(client)

    if voice:
        say(f"\nготово: голосовых отправлено {sent_n} из {len(todo)}")
    else:
        say(f"\nготово: черновиков разложено {ok_n} из {len(todo)}")
        say(f"отправлено сообщений: {sent_n}" if send
            else "они лежат в чатах — ничего не отправлено")

    # кому ещё не написано — считаем по файлу заново: рядом могли отработать
    # другие аккаунты
    log2 = tglib.read_csv(tglib.DRAFTS)
    already2 = {r["phone"] for r in log2
                if r.get("ok") in ("true", "skip") or r.get("sent") == "true"}
    tries2 = tglib.tries_by_phone(log2, already2)
    left = sum(1 for r in tglib.read_csv(tglib.RESULTS)
               if r.get("tg") == "true" and r["phone"] not in already2
               and tries2.get(r["phone"], 0) < MAX_TRIES
               and tglib.can_write(r, acc["id"])
               and (not leads_only or r["phone"] in tglib.lead_refs()))
    tglib.state(done=ok_n, left=left, stop=stop, cooldown=cooldown)


asyncio.run(main())
