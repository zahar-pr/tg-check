#!/usr/bin/env python3
"""
Поиск чатов для обогащения: тема -> ключевики (модель) -> чаты (поиск Telegram).

Шаг 1, без Telegram — ключевики по теме:
    python enrich-find.py --keywords --topic "Квартиры в Екатеринбурге"
Модель выдаёт сотни коротких запросов: застройщики, ЖК, районы, «ипотека екб»,
«соседи ЖК …». Список ложится в enrich/keywords.json — его можно поправить в
панели перед поиском.

Шаг 2, аккаунтом-читателем — поиск по ключевикам и похожим каналам:
    python enrich-find.py --account r1 [--per-run 40] [--dry]
По каждому ключевику — родной поиск Telegram (contacts.Search), пауза 2–4 с.
Потом у каналов из очереди спрашиваем похожие (channels.GetChannelRecommendations
— то, что Telegram показывает под каналом «Похожие каналы»), до двух шагов
вглубь. Берём публичные группы и каналы с комментариями, модель отсеивает
чужие темы по названию, остальное идёт в очередь (enrich/chats.json). Дубли по
chat_id и ссылке отсекаются там же. Пройденные ключевики и каналы помечаются:
следующий заход продолжит с непройденных.
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

PER_RUN = 40              # ключевиков за заход: поиск — заметный запрос
SIMILAR_PER_RUN = 10      # каналов, у которых за заход спрашиваем похожие
PAUSE = (2, 4)
MIN_MEMBERS = 30          # совсем пустые чаты не читаем
FLOOD_MAX = 120

# Ключевики — порциями: двести штук одним ответом многословная модель не
# укладывает ни в лимит токенов, ни в таймаут, и весь ответ пропадал
KW_ROUND = 60             # ключевиков за один запрос
KW_TARGET = 180           # всего: раунды идут, пока не наберём или не иссякнет
KW_ROUNDS = 5
KW_TOKENS = 12000         # потолок, а не плата: «думающая» модель тратит часть на рассуждения
KW_TIMEOUT = 180          # сек на один ответ модели

KW_PROMPT = """Тема: «{topic}».{goal}
Составь {n} поисковых запросов, по которым в поиске Telegram найдутся
чаты и каналы, где сидят люди по этой теме. Запросы короткие (1–3 слова), как
люди называют свои чаты и каналы. Перебирай конкретное:
- названия мест, компаний, брендов, объектов, товаров по теме (для жилья —
  застройщики и ЖК, для авто — марки и автосалоны, и т.п.);
- город, районы, пригороды, сокращения и варианты написания города;
- сообщества: «соседи …», «чат дома …», «родители …», «барахолка …» и т.п.;
- обычные запросы людей по теме вместе с городом.
НЕ пиши общие слова без места и названия («квартира», «недвижимость»,
«продажа», «риелтор», «агентство», «ипотека»): по ним находятся каналы
продавцов и агентств, а нам нужны чаты, где сидят сами покупатели/клиенты.{have}
Ответь ТОЛЬКО JSON-массивом строк, без нумерации и пояснений."""

PLAN_PROMPT = """Владелец написал, кого ищет: «{query}».
Разверни это для системы, которая ищет таких людей в Telegram-чатах:
- goal — кого ищем, одной фразой в форме «хочет/ищет …» (с местом, если оно есть);
- topic — тема для поиска чатов, 2–5 слов (с городом, если он есть);
- keywords — 40 коротких поисковых запросов (1–3 слова), как люди называют
  свои чаты и каналы по этой теме: конкретные места, компании, объекты,
  районы, сообщества («соседи …», «чат …»), сокращения города. Без общих слов
  вроде «недвижимость», «продажа», «риелтор» — по ним находятся продавцы.
Ответь ТОЛЬКО JSON без пояснений:
{{"goal": "...", "topic": "...", "keywords": ["...", "..."]}}"""

FIT_PROMPT = """Ищем Telegram-чаты, где можно найти людей, которые {goal}.
Тема поиска: «{topic}».
Ниже чаты: номер, название, тип. Подходят чаты, где обсуждают эту тему или
где по месту и составу сидят такие люди (городские и районные, по объектам
и сообществам темы). Не подходят: другие города (если город задан), другая
тематика, чисто рекламные каналы продавцов без обсуждения.
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


def strings_from(out, start):
    """Целые строки JSON-массива с позиции start; массив может быть обрезан."""
    words = []
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"\s*(,|\]|$)', out[start:]):
        try:
            words.append(json.loads('"' + m.group(1) + '"'))
        except ValueError:
            continue
        if m.group(2) == "]":
            break
    return words


def word_list(out):
    """Список строк из ответа: целый массив, а если ответ обрезан — что успело."""
    words = last_json(out, str)
    if words is None:
        starts = list(re.finditer(r'\[\s*"', out or ""))
        words = strings_from(out, starts[-1].start() + 1) if starts else []
    return [w for w in words if isinstance(w, str) and w.strip(' .…"\'«»')]


def ask_text(prompt, temperature):
    """Ответ модели на длинную генерацию; пустой — ещё одна попытка."""
    out = None
    for _ in range(2):
        out = llm.chat("Отвечай строго в формате, который просят.", prompt,
                       max_tokens=KW_TOKENS, temperature=temperature, tries=2, timeout=KW_TIMEOUT)
        if out:
            break
    return out


def gather(topic, goal="", seed=()):
    """
    Ключевики раундами по KW_ROUND: каждый следующий просит других, не тех,
    что уже есть. Раунд, который дал мало нового, — последний.
    """
    words, seen = [], set()

    def take(ws):
        new = [w for w in (" ".join(str(x).split())[:60] for x in ws) if w and w.lower() not in seen]
        for w in new:
            seen.add(w.lower())
        words.extend(new)
        return len(new)

    take(seed)
    for _ in range(KW_ROUNDS):
        if len(words) >= KW_TARGET:
            break
        have = ("\nУже есть — НЕ повторяй их, дай другие: " + ", ".join(words))[:4000] if words else ""
        out = ask_text(KW_PROMPT.format(topic=topic, goal=f"\nИщем людей, которые {goal}." if goal else "",
                                        n=KW_ROUND, have=have), 0.7)
        if not out:
            say(f"  модель не ответила ({llm.LAST_ERR or 'нет ответа'}) — беру, что есть")
            break
        n = take(word_list(out))
        say(f"  +{n} ключевиков, всего {len(words)}")
        if n < 10:
            break
    return words


def save_keywords(topic, words):
    """Ключевики в enrich/keywords.json без дублей; новое «at» — старый поиск по ним остановится."""
    seen, items = set(), []
    for w in words:
        w = " ".join(str(w).split())[:60]
        if w and w.lower() not in seen:
            seen.add(w.lower())
            items.append({"q": w, "done": False, "found": 0})
    enrich.write_json(enrich.KEYWORDS, {"topic": topic, "at": enrich.now_iso(), "items": items})
    return items


PLAN_MIN = 10       # меньше ключевиков — это не план, а обрывок или шаблон


def _blank(s):
    return not str(s or "").strip(" .…\"'«»")


def parse_plan(out):
    """
    (goal, topic, keywords) из ответа модели — или None. Модели с рассуждениями
    повторяют в ответе шаблон из промпта ({"goal": "...", …}) и потом пишут
    настоящий JSON, который бывает обрезан. Поэтому идём с конца и берём только
    объект, похожий на план: цель и тема не «...», ключевики — список настоящих
    строк, и их не меньше PLAN_MIN.
    """
    dec = json.JSONDecoder(strict=False)
    for m in reversed(list(re.finditer(r'\{\s*"goal"', out or ""))):
        try:
            plan, _ = dec.raw_decode(out, m.start())
        except ValueError:
            continue
        if not isinstance(plan, dict) or not isinstance(plan.get("keywords"), list):
            continue
        words = [w for w in plan["keywords"] if isinstance(w, str) and not _blank(w)]
        if _blank(plan.get("goal")) or _blank(plan.get("topic")) or len({w.lower() for w in words}) < PLAN_MIN:
            continue
        return (" ".join(str(plan["goal"]).split())[:300], " ".join(str(plan["topic"]).split())[:100], words)
    return None


def salvage_plan(out):
    """Ответ обрезан: цель и тема обычно целы, из ключевиков — что успело."""
    def field(name):
        m = None
        for m in re.finditer(r'"%s"\s*:\s*"((?:[^"\\]|\\.)*)"' % name, out or ""):
            pass                                    # последнее вхождение: шаблон из промпта — раньше
        return " ".join(m.group(1).split()) if m else ""
    goal, topic = field("goal"), field("topic")
    if _blank(goal) or _blank(topic):
        return None
    kw = list(re.finditer(r'"keywords"\s*:\s*\[', out or ""))
    return goal[:300], topic[:100], (strings_from(out, kw[-1].end()) if kw else [])


def make_plan(query):
    """
    Автопилот: из одной фразы владельца («хочет квартиру в Екб») — цель для
    разбора, тема для поиска чатов и ключевики. Последней строкой — JSON для
    панели: цель и тему она сохраняет в enrich/state.json сама.
    """
    out = ask_text(PLAN_PROMPT.format(query=query), 0.5)
    plan = (parse_plan(out) or salvage_plan(out)) if out else None
    if not plan:
        why = llm.LAST_ERR or ("пустой ответ" if out == "" else (out or "")[:120])
        raise SystemExit(f"модель не разобрала запрос: {why}")
    goal, topic, seed = plan
    say(f"кого ищем: {goal}")
    say(f"тема поиска: {topic} · добираю ключевики порциями")
    words = gather(topic, goal, seed)
    if len(words) < PLAN_MIN:
        raise SystemExit(f"модель не разобрала запрос: ключевиков мало ({len(words)}) — {llm.LAST_ERR or 'попробуй ещё раз'}")
    items = save_keywords(topic, words)
    say(f"ключевиков: {len(items)}")
    say(", ".join(i["q"] for i in items[:40]) + (" …" if len(items) > 40 else ""))
    print(json.dumps({"ok": True, "goal": goal, "topic": topic, "n": len(items)}, ensure_ascii=False), flush=True)


def make_keywords(topic):
    words = gather(topic)
    if not words:
        raise SystemExit(f"модель не дала список ключевиков: {llm.LAST_ERR or 'пустой ответ'}")
    items = save_keywords(topic, words)
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


def candidate(c, known):
    """Чат из выдачи Telegram (поиск, похожие) -> кандидат в очередь, или None."""
    from telethon.tl.types import Channel
    if not isinstance(c, Channel) or not c.username or str(c.id) in known:
        return None
    if c.broadcast and not getattr(c, "has_link", False):
        return None                        # канал без комментариев: людей не видно
    if getattr(c, "join_request", False):
        return None                        # пускают по заявке админу — не наш случай
    if (c.participants_count or MIN_MEMBERS) < MIN_MEMBERS:
        return None
    return {"ref": "@" + c.username, "chat_id": c.id, "title": tglib.cell(c.title),
            "n": c.participants_count or "", "kind": "channel" if c.broadcast else "group"}


def bump_seed_fail(key):
    """Модель дважды не поняла, что из похожих по теме, — этот канал больше не раскрываем."""
    v = enrich.load_chats().get(key) or {}
    n = int(v.get("similar_fail") or 0) + 1
    enrich.set_chat(key, similar_fail=n, **({"similar": True} if n >= 2 else {}))


async def similar(client, topic, known, dry, budget):
    """
    Похожие каналы по родным рекомендациям Telegram (channels.GetChannelRecommendations):
    от каждого канала из очереди — на шаг вглубь, до enrich.SIMILAR_LEVELS. Тот же
    фильтр и та же оценка темы моделью, что у поиска по ключевикам.
    Возвращает (добавлено, флуд-пауза, stop).
    """
    from telethon import functions
    from telethon.errors import FloodWaitError
    from telethon.tl.types import InputPeerChannel

    seeds = enrich.similar_seeds()[:budget]
    if seeds:
        say(f"\nпохожие каналы: проверяю {len(seeds)} из {len(enrich.similar_seeds())}")
    added = 0
    for n, (key, seed) in enumerate(seeds):
        if not dry and not enrich.read_json(enrich.STATE, {}).get("finding"):
            say("поиск остановлен в панели")
            break
        r, invite = chat_ref(seed["ref"])
        if invite:                       # по приглашению похожих не спросишь
            if not dry:
                enrich.set_chat(key, similar=True)
            continue
        try:
            # Из сессии, а не поиском по нику: канал аккаунт уже видел (поиск,
            # похожие), а ResolveUsername пачкой — прямая дорога к флуд-паузе
            ent = await client.get_input_entity(r)
            if not isinstance(ent, InputPeerChannel):
                # ник теперь у человека или бота — похожих тут не будет
                say(f"{seed['ref']}: это уже не канал — пропускаю")
                if not dry:
                    enrich.set_chat(key, similar=True)
                await asyncio.sleep(random.uniform(*PAUSE))
                continue
            res = await client(functions.channels.GetChannelRecommendationsRequest(channel=ent))
        except FloodWaitError as e:
            say(f"  флуд-пауза {e.seconds} с")
            if e.seconds > FLOOD_MAX:
                return added, e.seconds, ""
            await asyncio.sleep(e.seconds)
            continue
        except (SystemExit, Exception) as e:
            msg = str(e).splitlines()[0][:80] if str(e) else type(e).__name__
            if tglib.is_frozen_error(e) or isinstance(e, (ConnectionError, OSError)) \
                    or (isinstance(getattr(e, "code", None), int) and (e.code >= 500 or e.code < 0)):
                # связь, сбой Telegram, заморозка — беда не канала: стоп, продолжим позже
                say(f"{seed['ref']}: похожие не получить ({msg}) — остановлюсь, продолжу позже")
                return added, 0, "errors"
            # канал удалили, переименовали, это теперь группа, ошибка запроса —
            # дважды так, и больше его не раскрываем: один канал не держит поиск
            say(f"{seed['ref']}: похожие не получить ({msg}) — пропускаю")
            if not dry:
                bump_seed_fail(key)
            await asyncio.sleep(random.uniform(*PAUSE))
            continue
        cands = [c for c in (candidate(x, known) for x in (res.chats or [])) if c]
        good = fit(topic, cands)
        if good is None or good == DOWN:
            if good is None and not dry:
                bump_seed_fail(key)
            return added, 0, "errors"
        for c in good:
            known.add(str(c["chat_id"]))
        level = int(seed.get("level") or 0) + 1
        got = 0 if dry else enrich.add_chats(
            [{**{k: c[k] for k in ("ref", "chat_id", "title", "n", "kind")}, "level": level} for c in good],
            source=f"похожие на {seed['ref']}")
        added += got
        say(f"{seed['ref']}: похожих {len(cands)}, по теме {len(good)}"
            + ("" if dry else f", новых в очереди {got}")
            + ("".join(f"\n    {c['ref']} — {c['title']}" for c in good) if dry else ""))
        if not dry:
            enrich.set_chat(key, similar=True, similar_found=len(good))
        if n < len(seeds) - 1:
            await asyncio.sleep(random.uniform(*PAUSE))
    return added, 0, ""


async def search(acc, per_run, dry):
    from telethon import functions
    from telethon.errors import FloodWaitError
    from telethon.tl.types import Channel

    kw = enrich.read_json(enrich.KEYWORDS, {})
    at0 = kw.get("at")
    # без темы (каналы добавили ссылками) модель судит по цели разбора
    topic = kw.get("topic") or enrich.read_json(enrich.STATE, {}).get("topic") or enrich.goal()
    todo = [i for i in kw.get("items", []) if not i.get("done")]
    if not todo and not enrich.similar_seeds():
        say("искать нечего: ключевики пройдены, похожие на все каналы уже проверены")
        tglib.state(done=0, left=0)
        return
    say(f"тема: {topic} · ключевиков осталось {len(todo)}, за этот заход до {per_run}; "
        f"каналов, у которых проверим похожие: {len(enrich.similar_seeds())}")

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
                got_c = candidate(c, known)
                if got_c:
                    cands.append(got_c)
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
                [{k: c[k] for k in ("ref", "chat_id", "title", "n", "kind")} for c in good],
                source=f"поиск: {item['q']}")
            added += got
            say(f"«{item['q']}»: найдено {len(cands)}, по теме {len(good)}"
                + ("" if dry else f", новых в очереди {got}")
                + ("".join(f"\n    {c['ref']} — {c['title']}" for c in good) if dry else ""))
            if not dry and not mark_done(item["q"], len(good), at0):
                say("ключевики подобраны заново — этот заход заканчиваю")
                break
            if n < min(per_run, len(todo)) - 1:
                await asyncio.sleep(random.uniform(*PAUSE))
        # ключевики этого захода прошли спокойно — у найденных каналов спрашиваем похожие
        if not wait and not stop:
            got, wait, stop = await similar(client, topic, known, dry, SIMILAR_PER_RUN)
            added += got
    finally:
        await tglib.aclose(client)
    kw_left = sum(1 for i in enrich.read_json(enrich.KEYWORDS, {}).get("items", []) if not i.get("done"))
    sim_left = len(enrich.similar_seeds())
    left = kw_left + sim_left
    say(f"\nитого: в очередь добавлено чатов {added}, ключевиков осталось {kw_left}, "
        f"каналов для похожих {sim_left}")
    if wait:
        tglib.state(done=added, left=left, stop="flood", cooldown=wait)
    elif not todo and not stop:
        # шли только «похожие»: следующий заход — не сразу (панель подождёт сама,
        # читателя не держит), иначе запросы к Telegram шли бы подряд весь час
        tglib.state(done=added, left=left, note="похожие")
    else:
        # модель не отвечает — не дёргаем поиск каждую минуту
        tglib.state(done=added, left=left, stop=stop, cooldown=15 * 60 if stop else 0)


def main():
    if tglib.flag("plan"):
        query = str(tglib.arg("query", "") or "").strip()
        if not query:
            raise SystemExit("напиши, кого ищем: --query \"хочет квартиру в Екб\"")
        make_plan(query)
        return
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
