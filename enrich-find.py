#!/usr/bin/env python3
"""
Поиск чатов для обогащения: тема -> ключевики (модель) -> чаты (поиск Telegram).

Шаг 1, без Telegram — ключевики по теме:
    python enrich-find.py --keywords --topic "Квартиры в Екатеринбурге"
Модель выдаёт сотни коротких запросов: застройщики, ЖК, районы, «ипотека екб»,
«соседи ЖК …». Список ложится в enrich/keywords.json — его можно поправить в
панели перед поиском.

Шаг 2, аккаунтом-читателем — поиск по ключевикам:
    python enrich-find.py --account r1 [--per-run 40] [--dry]
По каждому ключевику — родной поиск Telegram (contacts.Search), пауза 2–4 с.
Берём публичные группы и каналы с комментариями, модель отсеивает чужие темы
по названию, остальное идёт в очередь (enrich/chats.json). Дубли по chat_id и
ссылке отсекаются там же. Пройденные ключевики помечаются: следующий заход
продолжит с непройденных.
"""
import asyncio
import json
import random
import re

import enrich
import llm
import tglib
from tglib import say

PER_RUN = 40              # ключевиков за заход: поиск — заметный запрос
PAUSE = (2, 4)
MIN_MEMBERS = 30          # совсем пустые чаты не читаем
FLOOD_MAX = 120

KW_PROMPT = """Тема: «{topic}».
Составь список поисковых запросов, по которым в поиске Telegram найдутся
чаты и каналы, где сидят люди по этой теме. Нужны 150–250 коротких запросов
(1–3 слова), как люди называют свои чаты:
- застройщики и их ЖК, названия жилых комплексов;
- районы, микрорайоны, улицы, пригороды;
- «новостройки <город>», «ипотека <город>», «квартира <город>», «соседи ЖК …»,
  «дольщики …», «чат дома …», «переезд в <город>», «аренда <город>» и т.п.;
- сокращения города (екб, ебург) и варианты написания.
Ответь ТОЛЬКО JSON-массивом строк, без пояснений."""

FIT_PROMPT = """Ищем Telegram-чаты, где можно найти людей, которые {goal}.
Тема поиска: «{topic}».
Ниже чаты: номер, название, тип. Подходят городские и районные чаты, чаты ЖК,
домов, дольщиков, новостроек, ипотеки, переезда, недвижимости этого города.
Не подходят: другие города, другая тематика (работа, авто, знакомства, мамы),
чисто рекламные каналы застройщиков и агентств без обсуждения.
Ответь ТОЛЬКО JSON-массивом номеров подходящих чатов.

{items}"""


def last_json(out, kind):
    """Последний JSON-массив в ответе: рассуждения модели идут до него."""
    found = None
    for m in re.finditer(r"\[[^\[\]]*\]", out or "", re.S):
        try:
            d = json.loads(m.group(0))
        except Exception:
            continue
        if isinstance(d, list) and kind is int and all(isinstance(x, str) and x.strip().isdigit() for x in d):
            d = [int(x) for x in d]             # ["0","2"] — те же номера строкой
        if isinstance(d, list) and all(isinstance(x, kind) for x in d):
            found = d
    return found


def make_keywords(topic):
    out = llm.chat("Отвечай строго в формате, который просят.", KW_PROMPT.format(topic=topic),
                   max_tokens=4000, temperature=0.7)
    words = last_json(out, str)
    if not words:
        raise SystemExit(f"модель не дала список ключевиков: {llm.LAST_ERR or (out or '')[:120]}")
    seen, items = set(), []
    for w in words:
        w = " ".join(str(w).split())[:60]
        if w and w.lower() not in seen:
            seen.add(w.lower())
            items.append({"q": w, "done": False, "found": 0})
    enrich.write_json(enrich.KEYWORDS, {"topic": topic, "at": enrich.now_iso(), "items": items})
    say(f"ключевиков: {len(items)}")
    say(", ".join(i["q"] for i in items[:40]) + (" …" if len(items) > 40 else ""))
    tglib.state(done=len(items), left=0)


DOWN = "down"       # модель недоступна (сеть, деньги, ключ) — ключевик тут ни при чём


def fit(topic, cands):
    """Модель отсеивает чужие темы по названию. None — модель не ответила:
    ключевик тогда не считаем пройденным, повторим позже (а не сваливаем в
    очередь всё подряд — каждый лишний чат стоит читателю вступления)."""
    if not cands:
        return []
    items = "\n".join(f"{i}. {c['title']} ({'канал' if c['kind'] == 'channel' else 'группа'})"
                      for i, c in enumerate(cands))
    info = {}
    out = llm.chat("Отвечай строго в формате, который просят.",
                   FIT_PROMPT.format(goal=enrich.goal(), topic=topic, items=items),
                   max_tokens=400, temperature=0, info=info)
    if out is None:
        # отказ из-за САМИХ названий (модерация, «Content Exists Risk», длинно)
        # повторится — это как непонятный ответ: после двух раз ключевик пропустим
        code = str(info.get("code", ""))
        if code in ("400", "403", "413") or "content exists risk" in (llm.LAST_ERR or "").lower():
            say(f"  модель отказалась оценить темы ({llm.LAST_ERR or code}) — ключевик повторю позже")
            return None
        say(f"  модель недоступна ({llm.LAST_ERR or 'нет ответа'}) — ключевик подождёт")
        return DOWN
    nums = last_json(out, int)
    if nums is None:
        say(f"  модель не оценила темы ({llm.LAST_ERR or 'непонятный ответ'}) — этот ключевик повторю позже")
        return None
    return [cands[i] for i in nums if 0 <= i < len(cands)]


def current(q, at0):
    """Ключевик ещё в списке и не пройден? Список могли поправить в панели посреди поиска."""
    cur = enrich.read_json(enrich.KEYWORDS, {})
    if cur.get("at") != at0:
        return None
    return next((it for it in cur.get("items", []) if str(it.get("q", "")).lower() == q.lower()), None)


def bump_fit_fail(q, at0):
    """Модель не оценила темы по этому ключевику: после двух раз ключевик пропускаем."""
    cur = enrich.read_json(enrich.KEYWORDS, {})
    if cur.get("at") != at0:
        return
    for it in cur.get("items", []):
        if str(it.get("q", "")).lower() == q.lower():
            it["fit_fail"] = int(it.get("fit_fail") or 0) + 1
            if it["fit_fail"] >= 2:
                it.update(done=True, found=0)
    enrich.write_json(enrich.KEYWORDS, cur)


def mark_done(q, found, at0):
    """
    Отметить ключевик пройденным в СВЕЖЕМ файле: пока шёл поиск, список могли
    поправить в панели — свою старую копию поверх не пишем. Подобрали
    ключевики заново (другое «at») — этот заход больше не нужен: False.
    """
    cur = enrich.read_json(enrich.KEYWORDS, {})
    if cur.get("at") != at0:
        return False
    for it in cur.get("items", []):
        if str(it.get("q", "")).lower() == q.lower():
            it.update(done=True, found=found)
    enrich.write_json(enrich.KEYWORDS, cur)
    return True


async def search(acc, per_run, dry):
    from telethon import functions
    from telethon.errors import FloodWaitError
    from telethon.tl.types import Channel

    kw = enrich.read_json(enrich.KEYWORDS, {})
    at0 = kw.get("at")
    topic = kw.get("topic") or ""
    todo = [i for i in kw.get("items", []) if not i.get("done")]
    if not todo:
        say("непройденных ключевиков нет — сначала подбери ключевики по теме")
        tglib.state(done=0, left=0)
        return
    say(f"тема: {topic} · ключевиков осталось {len(todo)}, за этот заход до {per_run}")

    client = await tglib.connect(acc)
    known = {str(v.get("chat_id")) for v in enrich.load_chats().values() if v.get("chat_id")}
    added = wait = 0
    stop = ""
    try:
        for n, item in enumerate(todo[:per_run]):
            # «Остановить поиск» в панели: заканчиваем на этом ключевике, а не через 40
            if not dry and not enrich.read_json(enrich.STATE, {}).get("finding"):
                say("поиск остановлен в панели")
                break
            if not dry:
                it = current(item["q"], at0)
                if it is None and enrich.read_json(enrich.KEYWORDS, {}).get("at") != at0:
                    say("ключевики подобраны заново — этот заход заканчиваю")
                    break
                if it is None or it.get("done"):
                    continue                    # ключевик убрали из списка или его уже прошли
            try:
                res = await client(functions.contacts.SearchRequest(q=item["q"], limit=50))
            except FloodWaitError as e:
                say(f"  флуд-пауза {e.seconds} с")
                if e.seconds > FLOOD_MAX:
                    wait = e.seconds
                    break
                await asyncio.sleep(e.seconds)
                continue
            except Exception as e:
                msg = str(e).splitlines()[0][:80] if str(e) else type(e).__name__
                if getattr(e, "code", None) == 400 and not tglib.is_frozen_error(e):
                    # запрос не понравился Telegram (короткий, странные символы) —
                    # этот ключевик пропускаем, остальные ищем дальше
                    say(f"«{item['q']}»: Telegram не принял запрос ({msg}) — пропускаю")
                    if not dry and not mark_done(item["q"], 0, at0):
                        break
                    continue
                # связь, заморозка, сбой сервера — беда не ключевика: стоп, ключевики целы
                say(f"«{item['q']}»: поиск не вышел ({msg}) — остановлюсь, продолжу позже")
                stop = "errors"
                break
            cands = []
            for c in res.chats:
                if not isinstance(c, Channel) or not c.username or str(c.id) in known:
                    continue
                if c.broadcast and not getattr(c, "has_link", False):
                    continue                       # канал без комментариев: людей не видно
                if getattr(c, "join_request", False):
                    continue                       # пускают по заявке админу — не наш случай
                if (c.participants_count or MIN_MEMBERS) < MIN_MEMBERS:
                    continue
                cands.append({"ref": "@" + c.username, "chat_id": c.id, "title": tglib.cell(c.title),
                              "n": c.participants_count or "",
                              "kind": "channel" if c.broadcast else "group"})
            good = fit(topic, cands)
            if good is None or good == DOWN:
                # модель ответила, но непонятно, — дважды так, и ключевик пропускаем;
                # простой модели ключевику не засчитываем
                if good is None and not dry:
                    bump_fit_fail(item["q"], at0)
                stop = "errors"
                break
            for c in good:
                known.add(str(c["chat_id"]))
            got = 0 if dry else enrich.add_chats(
                [{k: c[k] for k in ("ref", "chat_id", "title", "n")} for c in good], source=f"поиск: {item['q']}")
            added += got
            say(f"«{item['q']}»: найдено {len(cands)}, по теме {len(good)}"
                + ("" if dry else f", новых в очереди {got}")
                + ("".join(f"\n    {c['ref']} — {c['title']}" for c in good) if dry else ""))
            if not dry and not mark_done(item["q"], len(good), at0):
                say("ключевики подобраны заново — этот заход заканчиваю")
                break
            if n < min(per_run, len(todo)) - 1:
                await asyncio.sleep(random.uniform(*PAUSE))
    finally:
        await tglib.aclose(client)
    left = sum(1 for i in enrich.read_json(enrich.KEYWORDS, {}).get("items", []) if not i.get("done"))
    say(f"\nитого: в очередь добавлено чатов {added}, ключевиков осталось {left}")
    if wait:
        tglib.state(done=added, left=left, stop="flood", cooldown=wait)
    else:
        # модель не отвечает — не дёргаем поиск каждую минуту
        tglib.state(done=added, left=left, stop=stop, cooldown=15 * 60 if stop else 0)


def main():
    if tglib.flag("keywords"):
        topic = str(tglib.arg("topic", "") or "").strip()
        if not topic:
            raise SystemExit("укажи тему: --topic \"Квартиры в Екатеринбурге\"")
        make_keywords(topic)
        return
    acc = tglib.resolve(tglib.arg("account", ""))
    per_run = int(tglib.arg("per-run", 0) or 0) or PER_RUN
    asyncio.run(search(acc, per_run, tglib.flag("dry")))


main()
