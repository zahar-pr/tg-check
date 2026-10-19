#!/usr/bin/env python3
"""
Разбор чатов: собирает участников групп и каналов — родным каналом Telegram
(MTProto), тем же аккаунтом и через тот же прокси, что и остальные задачи.

Два режима:

  --chat <ссылка>     один чат;
  --folder chats      ВСЕ чаты из папки Telegram с таким названием.

Второй — основной. Вступать в чаты руками всё равно приходится, а вот
перечислять их панели по одному незачем: сложи их в Telegram в папку (там же,
где «Личные», «Каналы»), и панель пройдёт по ней сама, чат за чатом, пока они
не кончатся или пока не упрётся в предел за заход. Где остановилась — помнит
(chats.json), поэтому следующий заход начинается с неразобранных.

Собранные люди попадают в те же файлы, что и проверенные номера (results.csv),
поэтому дальше их ведёт обычная рассылка: те же брони, те же дневные пределы,
то же «одному человеку пишем один раз».

Кого берём: живых людей. Боты, удалённые аккаунты и сам аккаунт-сборщик
отбрасываются — писать им некому и незачем.

Человека с @username потом может написать ЛЮБОЙ аккаунт панели, а того, у кого
ника нет, — только этот, который его нашёл (access_hash к человеку у каждого
аккаунта свой и лежит в его сессии). Поэтому --only-username берёт только
первых: база выходит меньше, зато рассылка по ней распараллеливается целиком.

    python parse-chat.py --account a1 --folder chats --limit 2000
    python parse-chat.py --account a1 --folder chats --only-username
    python parse-chat.py --account a1 --chat https://t.me/durov_chat
    python parse-chat.py --account a1 --chat https://t.me/+AbCdEf --join
    python parse-chat.py --account a1 --folder chats --again   # заново по всем

Ограничение Telegram: у больших публичных чатов постранично отдаётся первые
~10 000 участников. Больше не даст никакой клиент — это не наш предел.
"""
import asyncio
import atexit
import csv
import json
import random
import re

import claims
import tglib
from chatlib import chat_ref, locked, resolve_chat
from tglib import say

PAGE = 200                # столько участников за один запрос — предел Telegram
FLOOD_MAX = 600           # флуд-паузу дольше этой не пересиживаем
# Пауза считается не на страницу, а на людей: 2-3 секунды за каждую сотню
# собранных. Страница в 200 человек — это 4-6 секунд отдыха. Без этого
# большой чат разбирается «в лоб», и Telegram отвечает флуд-паузой, после
# которой заход всё равно встанет — только уже не на секунды.
PAUSE_PER_100 = (2, 3)
CHAT_PAUSE = 3            # между чатами: пауза заметнее, запросов там много
# Список участников скрыт настройкой чата — Telegram отдаёт только админов.
# Тогда берём авторов сообщений: столько последних сообщений просматриваем
# (100 за запрос, полторы секунды между запросами; ~0.5 КБ трафика на сообщение)
HISTORY = 3000

DONE = tglib.DIR / "chats.json"    # какие чаты уже разобраны


# ------------------------------------------------------------------ разное

def person(u, chat_title, by):
    """Строка про человека — то, что кладём в members.csv."""
    name = tglib.cell(" ".join(x for x in [u.first_name, u.last_name] if x))
    return {
        "key": tglib.member_key(u.username, u.id),
        "username": (u.username or ""),
        "name": name,
        "user_id": u.id,
        "chat": chat_title,
        "at": tglib.now_iso(),
        "by": by,
    }


def cap_of(*vals):
    """Наименьший из заданных пределов. 0 (или ничего) — предела нет."""
    live = [int(v) for v in vals if v]
    return min(live) if live else 0


def share_key(item, kind):
    """Имя чата в общей броне — одинаковое у всех аккаунтов этого профиля."""
    if kind == "folder":
        k = getattr(item, "channel_id", None) or getattr(item, "chat_id", None) or item
    else:
        try:
            ref, invite = chat_ref(item)
            k = invite or str(ref).lower()
        except SystemExit:
            k = str(item).lower()
    return f"chat:{tglib.DIR}:{k}"


def load_done():
    """Разобранные чаты: id -> когда и сколько взяли."""
    try:
        data = json.loads(DONE.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_chat(chat_id, rec):
    with locked(DONE):
        data = load_done()
        data[str(chat_id)] = rec
        tmp = DONE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
        tmp.replace(DONE)


def mark_done(chat_id, title, n, username=""):
    """Чат пройден ДО КОНЦА — больше не берём его в следующие заходы.
    username — публичный ник чата: по нему туда могут зайти другие аккаунты
    (комментарии в чатах), по одному id чат открывает только участник."""
    _save_chat(chat_id, {"title": title, "at": tglib.now_iso(), "n": n, "done": True, "offset": 0,
                         **({"username": username} if username else {})})


def mark_progress(chat_id, title, n, offset, username=""):
    """
    Чат обрезан пределом/флудом — запоминаем offset, чтобы следующий заход
    продолжил С ЭТОГО МЕСТА, а не с начала (иначе крупный чат вечно перечитывал
    бы первую страницу и участники за пределом не собирались никогда).
    """
    _save_chat(chat_id, {"title": title, "at": tglib.now_iso(), "n": n, "done": False, "offset": int(offset or 0),
                         **({"username": username} if username else {})})


def save_members(rows):
    """
    members.csv — полный список того, что разобрали: его можно скачать из
    панели и открыть в Excel. Файл переписываем целиком, чтобы люди из разных
    чатов не задваивались: ключ у человека один.
    """
    with locked(tglib.MEMBERS):
        return _save_members(rows)


def _save_members(rows):
    old = {r.get("key"): r for r in tglib.read_csv(tglib.MEMBERS) if r.get("key")}
    fresh = 0
    for r in rows:
        if r["key"] not in old:
            fresh += 1
        old[r["key"]] = r
    # перевод строки строго "\n": панель читает CSV простым разрезанием строк,
    # и \r от Windows-конца прилип бы к последней колонке
    # пишем во временный файл и подменяем атомарно (os.replace) — иначе при
    # параллельном разборе двумя аккаунтами две перезаписи затирают друг друга
    import os
    tmp = tglib.MEMBERS.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=tglib.MEMBERS_HEAD, lineterminator="\n")
        w.writeheader()
        for r in old.values():
            w.writerow({k: r.get(k, "") for k in tglib.MEMBERS_HEAD})
    os.replace(tmp, tglib.MEMBERS)
    return fresh, len(old)


# ----------------------------------------------------------------- чем брать

async def folder_chats(client, name):
    """
    Чаты из папки Telegram с таким названием. Папки — это то же самое, что
    человек видит слева от списка чатов; панель берёт из папки ровно те чаты,
    которые в неё добавлены поимённо.
    """
    from telethon import functions
    from telethon.tl.types import (DialogFilter, DialogFilterChatlist,
                                   InputPeerUser, InputPeerSelf)

    res = await client(functions.messages.GetDialogFiltersRequest())
    filters = getattr(res, "filters", res)      # старые слои отдавали список
    want = str(name).strip().casefold()
    found, names = None, []
    for f in filters:
        # «Все чаты» — не папка, у неё и названия нет
        if not isinstance(f, (DialogFilter, DialogFilterChatlist)):
            continue
        title = getattr(f.title, "text", f.title)   # в новых слоях это объект
        names.append(str(title))
        if str(title).strip().casefold() == want:
            found = f

    if found is None:
        have = ", ".join(f"«{n}»" for n in names) if names else "ни одной"
        raise SystemExit(
            f"в Telegram у этого аккаунта нет папки «{name}».\n"
            f"Есть: {have}.\n"
            "Заведи папку в Telegram (Настройки -> Папки), сложи в неё чаты "
            "и запусти снова.")

    if getattr(found, "groups", False) or getattr(found, "broadcasts", False):
        say("⚠ в папке включены «все группы/каналы» скопом — панель берёт только "
            "те чаты, что добавлены в неё поимённо")

    peers, seen = [], set()
    for p in list(getattr(found, "pinned_peers", []) or []) + list(found.include_peers or []):
        if isinstance(p, (InputPeerUser, InputPeerSelf)):
            continue                     # личная переписка — не чат с участниками
        key = getattr(p, "channel_id", None) or getattr(p, "chat_id", None)
        if not key or key in seen:
            continue
        seen.add(key)
        peers.append(p)
    return peers


async def pull(client, entity, limit, only_user=False, start_offset=0):
    """
    Участники постранично. У супергрупп и каналов — channels.GetParticipants:
    по 200 человек за раз, сдвигая offset, пока страницы не кончатся. Старые
    маленькие группы этого запроса не знают — там Telethon сам сходит за
    полным составом.

    Возвращает (люди, пауза): пауза больше нуля — Telegram попросил столько
    подождать, чат не дособран, и столько же отдыхает аккаунт.
    """
    from telethon.tl.functions.channels import GetParticipantsRequest, GetFullChannelRequest
    from telethon.tl.types import Channel, ChannelParticipantsSearch, User
    from telethon.errors import FloodWaitError

    me = await client.get_me()
    out, seen = [], set()

    def keep(u):
        if u.bot or u.deleted or u.id == me.id or u.id in seen:
            return False
        if only_user and not u.username:
            return False        # такого напишет только этот аккаунт — не берём
        seen.add(u.id)
        return True

    if not isinstance(entity, Channel):
        async for u in client.iter_participants(entity):
            if keep(u):
                out.append(u)
                if limit and len(out) >= limit:
                    return out, 0, 0, False        # обрезали пределом — не дочитан
        return out, 0, 0, True                     # маленькая группа прочитана целиком

    # скрытый список: участники не видны, видны только те, кто пишет в чат
    hidden = False
    try:
        full = await client(GetFullChannelRequest(entity))
        hidden = bool(getattr(full.full_chat, "participants_hidden", False))
    except Exception:
        pass
    if hidden:
        history = int(tglib.arg("history", 0) or 0) or HISTORY
        say(f"  участники скрыты — читаю последние {history} сообщений, беру авторов…")
        seen_msgs = 0
        async for m in client.iter_messages(entity, limit=history, wait_time=1.5):
            seen_msgs += 1
            u = m.sender
            if isinstance(u, User) and keep(u):
                out.append(u)
                if limit and len(out) >= limit:
                    break
        say(f"  участники скрыты — взял авторов сообщений: {len(out)} "
            f"(просмотрено {seen_msgs} сообщений)")
        return out, 0, 0, True

    offset = int(start_offset or 0)
    finished = False
    while True:
        try:
            part = await client(GetParticipantsRequest(
                channel=entity,
                filter=ChannelParticipantsSearch(""),
                offset=offset,
                limit=PAGE,
                hash=0,
            ))
        except FloodWaitError as e:
            if e.seconds > FLOOD_MAX:
                say(f"  стоп: Telegram просит подождать {e.seconds} с — "
                    f"собрано {len(out)}, остальное в следующий заход")
                return out, e.seconds, offset, False
            say(f"  … флуд-пауза {e.seconds} с")
            await asyncio.sleep(e.seconds)
            continue

        if not part.users:
            finished = True
            break
        for u in part.users:
            if keep(u):
                out.append(u)
        # сдвигаемся на ВСЕХ, кого отдал Telegram, а не на тех, кого оставили:
        # offset — это его счётчик, и пропуск ботов сбил бы страницы
        offset += len(part.users)
        say(f"  собрано {len(out)} (просмотрено {offset})")
        if limit and len(out) >= limit:
            return out[:limit], 0, offset, False       # обрезали пределом — не дочитан
        if len(part.users) < PAGE:
            finished = True
            break
        rest = len(part.users) / 100 * random.uniform(*PAUSE_PER_100)
        say(f"  пауза {rest:.0f} с")
        await asyncio.sleep(rest)

    return out, 0, offset, finished


async def take(client, entity, acc_id, cap, only_user=False, start_offset=0):
    """
    Один чат целиком: собрать, записать, отчитаться. Пишем сразу после чата,
    а не в конце всего прогона: иначе флуд-пауза на пятом чате обнулила бы
    работу по четырём предыдущим.
    """
    title = tglib.cell(getattr(entity, "title", None)
                       or getattr(entity, "username", "") or str(entity.id))
    say(f"\n▸ {title}")
    users, wait, offset, finished = await pull(client, entity, cap, only_user, start_offset)
    people = [p for p in (person(u, title, acc_id) for u in users) if p["key"]]
    fresh, _ = save_members(people)
    added, dup = tglib.add_recipients(people, by=acc_id)
    say(f"  участников {len(people)} · новых в списке {fresh} · "
        f"в очередь на рассылку {added}" + (f" · уже были {dup}" if dup else ""))
    return title, people, added, wait, offset, finished


# ------------------------------------------------------------------- прогон

async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    limit = int(tglib.arg("limit", 0) or 0)            # людей за весь заход
    per_chat = int(tglib.arg("per-chat", 0) or 0)      # людей с одного чата
    folder = str(tglib.arg("folder", "") or "").strip()
    chat = str(tglib.arg("chat", "") or "").strip()
    list_file = str(tglib.arg("list", "") or "").strip()
    join = tglib.flag("join")
    again = tglib.flag("again")
    only_user = tglib.flag("only-username")
    # «i/N» — разбор идёт в N аккаунтов сразу, этот — i-й (панель, «все свободные»)
    part, parts = 0, 1
    share = str(tglib.arg("share", "") or "").strip()
    if re.fullmatch(r"\d+/\d+", share):
        part, parts = (int(x) for x in share.split("/"))

    if not folder and not chat and not list_file:
        raise SystemExit("укажи, откуда брать людей: --chat <ссылка>, --list <файл> или --folder <папка>")

    say(f"аккаунт: {acc['title']}  |  разбор чатов"
        f"{' (только с @username)' if only_user else ''}  |  "
        f"{tglib.proxy_label(acc.get('proxy'))}  |  Telethon")

    client = await tglib.connect(acc)
    say(f"сессия активна: {tglib.who(acc)}")

    from telethon.errors import (ChatAdminRequiredError, ChannelPrivateError,
                                 FloodWaitError)

    total_added = total_people = total_solo = 0
    chats_done = 0
    left_chats = 0
    why = ""           # почему остановился раньше конца списка — словами для ленты
    others = 0          # чаты, которые взяли другие аккаунты
    wait = 0            # сколько Telegram просит отдыхать, 0 — не просил
    try:
        # ---- собираем источники в единую очередь ----
        # folder — объекты-пиры из папки Telegram; chat/list — ссылки строками.
        # Дальше всё идёт одним циклом: разобрали, записали, пауза, следующий.
        if folder:
            items = await folder_chats(client, folder)
            kind = "folder"
        elif list_file:
            raw = open(list_file, encoding="utf-8").read()
            items = [ln.strip() for ln in raw.splitlines()
                     if ln.strip() and not ln.strip().startswith("#")]
            kind = "links"
        else:
            items = [chat]
            kind = "links"

        if parts > 1 and items:
            # Несколько аккаунтов делят один список: каждый начинает со своего
            # места и берёт чат, только если его ещё не взял другой (бронь в
            # claims.json; снимаем на выходе). Так чаты расходятся пачками сами,
            # и никто не ждёт: освободился — взял следующий свободный.
            k = len(items) * part // parts
            items = items[k:] + items[:k]
            atexit.register(lambda: claims.release_all(acc["id"], "parse"))
            say(f"разбор параллельно, аккаунтов: {parts} — этот начинает с {k + 1}-го источника "
                "и берёт те, что ещё никто не взял")
        done = {} if again else load_done()
        say(f"источников: {len(items)}"
            + (f", уже разобрано раньше {sum(1 for _ in done)}" if done else ""))
        if limit:
            say(f"предел за этот заход: {limit} человек")

        for i, item in enumerate(items):
            if limit and total_added >= limit:      # считаем НОВЫХ, а не сырой сбор с дублями
                left_chats = len(items) - i
                why = f"упёрся в предел «человек за заход» — {limit}"
                say(f"\nпредел за заход выбран ({limit} человек) — осталось источников: {left_chats}")
                break

            # чужой чат (его уже взял другой аккаунт) — пропускаем молча
            if parts > 1 and not claims.take(acc["id"], "parse", [share_key(item, kind)], 1):
                others += 1
                continue

            # получить сущность чата: из пира (папка) или из ссылки (список)
            try:
                if kind == "folder":
                    entity = await client.get_entity(item)
                else:
                    ref, invite = chat_ref(item)
                    entity = await resolve_chat(client, ref, invite, join)
            except FloodWaitError as e:
                say(f"\n▸ {item} — флуд-пауза {e.seconds} с, на сегодня хватит")
                wait, left_chats = e.seconds, len(items) - i
                break
            except SystemExit as e:
                say(f"\n▸ {item} — пропускаю: {str(e).splitlines()[0][:100]}")
                continue
            except Exception as e:
                say(f"\n▸ {item} — пропускаю: {str(e).splitlines()[0][:100] or type(e).__name__}")
                continue

            # в несколько аккаунтов чат мог только что дочитать сосед — смотрим свежий файл
            entry = (load_done() if parts > 1 and not again else done).get(str(entity.id))
            if entry and entry.get("done", True):     # старые записи без флага = дочитаны
                say(f"\n▸ {tglib.cell(getattr(entity, 'title', None) or entity.id)} — уже разобран раньше, "
                    "пропускаю (галочка «Заново по разобранным» — пройти снова)")
                continue
            start_offset = int(entry.get("offset", 0)) if entry else 0

            cap = cap_of(limit - total_added if limit else 0, per_chat)
            try:
                title, people, added, wait, offset, finished = await take(
                    client, entity, acc["id"], cap, only_user, start_offset)
            except ChatAdminRequiredError:
                say("  список участников закрыт настройками чата — пропускаю")
                mark_done(entity.id, tglib.cell(getattr(entity, "title", entity.id)), 0,
                          getattr(entity, "username", "") or "")
                continue
            except ChannelPrivateError:
                say("  чат приватный, аккаунт в нём не состоит — пропускаю")
                continue
            except FloodWaitError as e:
                say(f"  Telegram просит паузу {e.seconds} с — на сегодня хватит")
                wait, left_chats = e.seconds, len(items) - i
                break
            except Exception as e:
                say(f"  не вышло: {str(e).splitlines()[0][:120] or type(e).__name__}")
                continue

            total_people += len(people)
            total_added += added
            total_solo += sum(1 for x in people if not x["username"])
            chats_done += 1
            # дочитан до конца — помечаем done; обрезан пределом/флудом — сохраняем
            # offset, чтобы следующий заход продолжил С ЭТОГО МЕСТА (а не с нуля)
            if finished:
                mark_done(entity.id, title, len(people), getattr(entity, "username", "") or "")
            else:
                mark_progress(entity.id, title, len(people), offset, getattr(entity, "username", "") or "")
            if wait:
                left_chats = len(items) - i
                break
            if i < len(items) - 1:
                await asyncio.sleep(CHAT_PAUSE)
    finally:
        await tglib.aclose(client)

    say(f"\nитого: чатов разобрано {chats_done} · участников {total_people} · "
        f"в очередь на рассылку добавлено {total_added}")
    if others:
        say(f"чатов, которые взяли другие аккаунты: {others}")
    if wait and not why:
        why = f"Telegram попросил паузу {max(1, wait // 60)} мин"
    if left_chats and parts > 1:
        # число тут ничего не скажет: часть «оставшихся» уже разбирают соседи
        say(f"разбор остановлен ({why or 'не дошёл до конца'}) — остальные чаты разберут "
            "другие аккаунты, что не успеют — следующий запуск")
    elif left_chats:
        say(f"осталось чатов: {left_chats} ({why or 'не дошёл до конца'}) — запусти разбор "
            "ещё раз, панель продолжит с неразобранных")
    if total_added:
        say("им можно писать сразу — проверять номера тут нечего")
    if total_solo:
        say(f"из них без @username: {total_solo} — этих напишет только "
            f"«{acc['title']}», остальным аккаунтам они не видны "
            "(--only-username берёт лишь тех, кого напишет любой)")
    # flood — единственная причина, по которой аккаунту стоит отлежаться;
    # выбранный предел за заход отдыха не требует
    tglib.state(done=total_added, left=left_chats,
                stop="flood" if wait else "", cooldown=wait)


asyncio.run(main())
