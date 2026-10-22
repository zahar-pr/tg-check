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
from datetime import datetime, timezone

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

# Поиск Telegram (contacts.Search) ищет по НАЗВАНИЯМ и никам чатов. Ключевик —
# это то, как чат называется («ЖК Светлый», «ипотека Екб», «соседи Уралмаш»),
# а не фраза покупателя: «ищу квартиру екатеринбург покупка» не найдёт ничего.
# Поэтому: план разбирает запрос на место и слова темы — из них код сам
# собирает запросы; модель по отдельности называет конкретные имена (ЖК,
# застройщики, районы), сообщества и обсуждения; всё, что похоже на фразу
# покупателя или продавца, код выбрасывает.
KW_PER_FACET = 50
KW_MAX_WORDS = 3
KW_LIMIT = 400            # больше ключевиков не держим: снежный ком не разрастается
KW_TOKENS = 12000         # потолок, а не плата: «думающая» модель тратит часть на рассуждения
KW_TIMEOUT = 180          # сек на один ответ модели
# начала слов, с которыми запрос — фраза покупателя/продавца, а не название чата
BAD_QUERY = re.compile(
    r"(?<![а-яёa-z])(купи|купл|покуп|ищу|ищем|ищет|хочу|хотим|хочет|где|как|куда|помощ|помог|лучш|"
    r"дешев|цены|цена|стоимост|список|найти|поиск|подбор|посмотр|прода|агентст|риелт|риэлт|"
    r"объявлен|услуг|срочно|недорог|частн)", re.I)

FACETS = [
    ("имена", "Назови конкретные НАЗВАНИЯ по теме: компании, бренды, объекты, места. Для жилья — "
              "жилые комплексы (ЖК) и застройщики этого места, районы, микрорайоны и пригороды. "
              "Только настоящие названия, которые ты знаешь, — не выдумывай."),
    ("сообщества", "Назови, как называют СООБЩЕСТВА людей по теме: «соседи …», «жители …», «чат …», "
                   "«мамы …», «переезд в …», чаты районов, домов и посёлков."),
    ("обсуждения", "Назови ОБСУЖДЕНИЯ темы с местом: короткая тема + место (для жилья: «ипотека Екб», "
                   "«новостройки Екатеринбург», «дольщики Екб», «ремонт квартиры Екб»)."),
]

KW_PROMPT = """Ищем Telegram-чаты, где сидят люди, которые {goal}.
Поиск Telegram ищет по НАЗВАНИЯМ чатов — поэтому нужны не фразы, а то, как
такие чаты называются.

{facet}

Правила:
- каждый запрос — 1–3 слова, как в названии чата;
- без глаголов и вопросов: «купить», «ищу», «хочу», «где», «как», «помощь»;
- без слов продавцов: «продажа», «продам», «агентство», «риелтор», «объявления»;
- место — одним словом в конце, если нужно: {places}.
Пример хороших запросов для жилья в Екатеринбурге: «ЖК Солнечный», «соседи
Академический», «Брусника Екб», «ипотека Екб», «новостройки Екатеринбург»,
«Уралмаш чат», «переезд в Екатеринбург».{have}
Ответь ТОЛЬКО JSON-массивом из {n} строк."""

PLAN_PROMPT = """Владелец написал, кого ищет: «{query}».
Мы ищем Telegram-чаты, где пишут такие люди. Разбери запрос:
- goal — кого ищем, одной фразой «хочет/ищет …» (с местом, если оно есть);
- topic — тема, 2–4 слова;
- places — как это место пишут в названиях чатов: полное название и сокращения
  (для Екатеринбурга: «Екатеринбург», «Екб», «Екат», «Ебург»); места нет — [];
- nouns — 6–10 коротких слов темы, которые стоят в названиях таких чатов
  (для квартир: «квартиры», «новостройки», «ипотека», «ЖК», «недвижимость», «соседи»).
Ответь ТОЛЬКО JSON без пояснений:
{{"goal": "...", "topic": "...", "places": ["..."], "nouns": ["..."]}}"""

FIT_PROMPT = """Ищем Telegram-чаты, где ЖИВЫЕ ЛЮДИ переписываются и среди них есть те, кто {goal}.
Ниже найденные чаты: номер, название, тип, участников.

Подходят:
- чаты жителей и соседей: дома, ЖК, района, посёлка, города;
- обсуждения темы, где пишут обычные люди (для жилья: ипотека, новостройки,
  дольщики, ремонт, переезд);
- общие чаты города или района, если место совпадает;
- КАНАЛЫ С КОММЕНТАРИЯМИ застройщиков, ЖК, компаний по теме: под их постами
  («пишите в комментарии — скинем цены») отвечают покупатели.
Не подходят:
- доски объявлений — группы, где все сами продают или сдают («продам»,
  «сдам», «аренда», «объявления», «купить продать снять»);
- аренда и посуточно, работа и вакансии — если ищем не это;
- другой город или страна (если место задано), чужой язык;
- магазины, спам, новости без обсуждения.
Сомневаешься в месте или теме — не бери: каждый лишний чат стоит вступления.
Ответь ТОЛЬКО JSON-массивом номеров подходящих чатов, например [0, 3]; нет подходящих — [].

{items}"""

# Чат до вступления: последние сообщения без вступления — живой ли разговор людей
SAMPLE = 40
DEAD_DAYS = 30            # молчит дольше — мёртвый
MIN_AUTHORS = 4           # пишет меньше людей — канал или доска, а не разговор
AD_SHARE = 0.6            # столько объявлений среди сообщений — доска объявлений
AD_RE = re.compile(
    r"(\+7|(?<!\d)8)[\s\-()]*\d{3}[\s\-()]*\d{3}|(?<![а-яё])(продам|продаю|продаётся|продается|сдам|сдаю|"
    r"сдаётся|сдается|посуточно)|https?://|t\.me/", re.I)
# «ЖК Светлый», «мкр Академический» в названиях найденных чатов — новые ключевики
NAME_RE = re.compile(r"(?<![а-яёa-z])(ЖК|ЖР|КП|мкр\.?|микрорайон|квартал|посёлок|поселок)\s*[«\"“„]?"
                     r"([A-ZА-ЯЁ0-9][\wЁё\-]*(?:\s+[A-ZА-ЯЁ0-9][\wЁё\-]*)?)")


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


def good_query(q):
    """Похоже на название чата, а не на фразу покупателя или продавца?"""
    q = " ".join(str(q).replace("«", "").replace("»", "").replace('"', "").split())
    if not q or len(q) > 40 or len(q.split()) > KW_MAX_WORDS or q.isdigit():
        return ""
    return "" if BAD_QUERY.search(q) else q


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


def ask_text(prompt, temperature, tokens=None):
    """Ответ модели обогащения на длинную генерацию; пустой — ещё одна попытка."""
    # ГигаЧат не «думает» вслух: ему хватает 4000, и больше он может не принять
    tokens = tokens or (4000 if enrich.llm_provider() == "gigachat" else KW_TOKENS)
    out = None
    for _ in range(2):
        out = enrich.ask_llm("Отвечай строго в формате, который просят.", prompt,
                             max_tokens=tokens, temperature=temperature, tries=2, timeout=KW_TIMEOUT)
        if out:
            break
    return out


def make_stems(goal):
    """Корни слов темы для предфильтра разбора. Не вышло — разбор пойдёт без него."""
    got = enrich.make_stems(goal)
    if not got:
        say(f"корни слов темы не получил ({llm.LAST_ERR or 'мало'}) — разбор пойдёт без предфильтра")
        return []
    say(f"корни слов темы для предфильтра: {len(got)} — " + ", ".join(got[:25]) + (" …" if len(got) > 25 else ""))
    return got


def gather(topic, goal="", seed=(), places=()):
    """
    Ключевики: сперва seed (собраны кодом из места и слов темы), потом модель по
    граням — имена (ЖК, застройщики, районы), сообщества, обсуждения. Каждый
    следующий запрос видит, что уже есть. Отбор — good_query.
    """
    words, seen = [], set()
    goal = goal or enrich.goal()
    where = ", ".join(f"«{p}»" for p in places) or "если в цели есть место — его название и сокращения"

    def take(ws):
        new = []
        for w in ws:
            w = good_query(w)
            if w and w.lower() not in seen:
                seen.add(w.lower())
                new.append(w)
        words.extend(new)
        return len(new)

    take(seed)
    if seed:
        say(f"  из места и слов темы: {len(words)}")
    for name, facet in FACETS:
        have = ("\nУже есть — НЕ повторяй их, дай другие: " + ", ".join(words))[:3000] if words else ""
        out = ask_text(KW_PROMPT.format(goal=goal, facet=facet, places=where, n=KW_PER_FACET, have=have), 0.6)
        if not out:
            say(f"  {name}: модель не ответила ({llm.LAST_ERR or 'пусто'}) — дальше")
            continue
        n = take(word_list(out))
        say(f"  {name}: +{n}, всего {len(words)}")
    return words


def seeds(places, nouns):
    """Запросы, которые код собирает сам: место, «слово темы + место»."""
    places = [good_query(p) for p in places if good_query(p)][:4]
    nouns = [good_query(n) for n in nouns if good_query(n)][:10]
    out = list(places)
    for p in places[:3]:
        out += [f"{n} {p}" for n in nouns]
    return out if places else nouns


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
    {goal, topic, places, nouns} из ответа модели — или None. Модели с
    рассуждениями повторяют шаблон из промпта ({"goal": "...", …}) — берём
    последний объект с настоящими целью и темой.
    """
    dec = json.JSONDecoder(strict=False)
    for m in reversed(list(re.finditer(r'\{\s*"goal"', out or ""))):
        try:
            plan, _ = dec.raw_decode(out, m.start())
        except ValueError:
            continue
        if not isinstance(plan, dict) or _blank(plan.get("goal")) or _blank(plan.get("topic")):
            continue
        lst = lambda k: [str(x) for x in plan.get(k) or [] if isinstance(x, str) and not _blank(x)] \
            if isinstance(plan.get(k), list) else []
        return {"goal": " ".join(str(plan["goal"]).split())[:300], "topic": " ".join(str(plan["topic"]).split())[:100],
                "places": lst("places")[:6], "nouns": lst("nouns")[:12]}
    return None


def make_plan(query):
    """
    Автопилот: из одной фразы владельца («хочет квартиру в Екб») — цель для
    разбора, тема для поиска чатов и ключевики. Последней строкой — JSON для
    панели: цель и тему она сохраняет в enrich/state.json сама.
    """
    out = ask_text(PLAN_PROMPT.format(query=query), 0.3, tokens=None)
    plan = parse_plan(out) if out else None
    if not plan:
        why = llm.LAST_ERR or ("пустой ответ" if out == "" else (out or "")[:120])
        raise SystemExit(f"модель не разобрала запрос: {why}")
    goal, topic = plan["goal"], plan["topic"]
    say(f"кого ищем: {goal}")
    say(f"тема: {topic} · место: {', '.join(plan['places']) or '—'} · слова темы: {', '.join(plan['nouns']) or '—'}")
    words = gather(topic, goal, seeds(plan["places"], plan["nouns"]), plan["places"])
    if len(words) < PLAN_MIN:
        raise SystemExit(f"модель не разобрала запрос: ключевиков мало ({len(words)}) — {llm.LAST_ERR or 'попробуй ещё раз'}")
    items = save_keywords(topic, words)
    say(f"ключевиков: {len(items)}")
    say(", ".join(i["q"] for i in items[:40]) + (" …" if len(items) > 40 else ""))
    make_stems(goal)
    print(json.dumps({"ok": True, "goal": goal, "topic": topic, "n": len(items)}, ensure_ascii=False), flush=True)


def make_keywords(topic):
    words = gather(topic)
    if not words:
        raise SystemExit(f"модель не дала список ключевиков: {llm.LAST_ERR or 'пустой ответ'}")
    items = save_keywords(topic, words)
    say(f"ключевиков: {len(items)}")
    say(", ".join(i["q"] for i in items[:40]) + (" …" if len(items) > 40 else ""))
    make_stems(enrich.goal())
    tglib.state(done=len(items), left=0)


DOWN = "down"       # модель недоступна (сеть, деньги, ключ) — ключевик тут ни при чём


def fit(topic, cands):
    """Модель отсеивает чужие темы по названию. None — модель не ответила:
    ключевик тогда не считаем пройденным, повторим позже (а не сваливаем в
    очередь всё подряд — каждый лишний чат стоит читателю вступления)."""
    if not cands:
        return []
    items = "\n".join(f"{i}. {c['title']} — {'канал с комментариями' if c['kind'] == 'channel' else 'группа'}"
                      + (f", участников {c['n']}" if c.get("n") else "") for i, c in enumerate(cands))
    info = {}
    out = enrich.ask_llm("Отвечай строго в формате, который просят.",
                         FIT_PROMPT.format(goal=enrich.goal(), topic=topic, items=items),
                         max_tokens=1500, temperature=0, info=info)
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
            "n": c.participants_count or "", "kind": "channel" if c.broadcast else "group", "_obj": c}


QUEUE_KEYS = ("ref", "chat_id", "title", "n", "kind", "sample")


async def qualify(client, c):
    """
    Живой ли это разговор людей — по последним SAMPLE сообщениям, без
    вступления (публичную группу Telegram показывает и так). (годится, почему
    нет, сводка). Не дали посмотреть — пускаем: решит чтение.
    """
    from telethon import functions
    from telethon.errors import FloodWaitError
    obj = c.get("_obj")
    if obj is None:
        return True, "", {}
    try:
        target = obj
        if obj.broadcast:                   # у канала люди пишут в обсуждении
            full = await client(functions.channels.GetFullChannelRequest(obj))
            lid = getattr(full.full_chat, "linked_chat_id", None)
            target = next((x for x in full.chats if x.id == lid), None)
            if target is None:
                return False, "у канала нет обсуждения", {}
        msgs = await client.get_messages(target, limit=SAMPLE)
    except FloodWaitError:
        raise
    except Exception:
        return True, "", {"note": "не дали посмотреть без вступления"}
    # только люди: в обсуждении канала его посты приходят от самого канала
    # (sender_id < 0) — это не разговор, и цены в них объявлениями не считаем
    texts = [m for m in msgs if getattr(m, "message", None) and (getattr(m, "sender_id", None) or 0) > 0]
    if not texts:
        return False, "нет сообщений людей", {}
    days = max(0, (datetime.now(timezone.utc) - texts[0].date).days)
    authors = len({m.sender_id for m in texts})
    ads = sum(1 for m in texts if AD_RE.search(m.message)) / len(texts)
    sample = {"days": days, "authors": authors, "ads": round(ads, 2), "msgs": len(texts)}
    if days > DEAD_DAYS:
        return False, f"мёртвый: последнее сообщение {days} дн. назад", sample
    if authors < MIN_AUTHORS:
        return False, f"пишут {authors} чел. — канал или доска, а не разговор", sample
    if ads >= AD_SHARE:
        return False, f"доска объявлений: {round(ads * 100)}% — объявления", sample
    return True, "", sample


REJECTED = enrich.ROOT / "rejected.json"     # отсеянные чаты: второй раз не проверяем


def reject(c, why):
    data = enrich.read_json(REJECTED, {})
    data[str(c["chat_id"])] = {"title": c.get("title", ""), "why": why, "at": enrich.now_iso()}
    enrich.write_json(REJECTED, data)


async def screen(client, topic, cands, known, dry):
    """
    Кандидаты -> годные в очередь: модель по названию, потом проверка живости.
    None/DOWN — как у fit. Отсеянных запоминаем: другой ключевик их не вернёт.
    """
    from telethon.errors import FloodWaitError
    good = fit(topic, cands)
    if good is None or good == DOWN:
        return good
    ids = {str(c["chat_id"]) for c in good}
    for c in cands:
        known.add(str(c["chat_id"]))
        if str(c["chat_id"]) not in ids and not dry:
            reject(c, "не по теме (модель)")
    out = []
    for c in good:
        try:
            ok, why, sample = await qualify(client, c)
        except FloodWaitError as e:
            if e.seconds > FLOOD_MAX:
                raise
            await asyncio.sleep(e.seconds)
            ok, why, sample = True, "", {}
        if ok:
            out.append({**c, "sample": sample} if sample else c)
        else:
            say(f"    мимо: {c['title']} — {why}")
            if not dry:
                reject(c, why)
        await asyncio.sleep(random.uniform(1, 2))
    return out


def snowball(chats, at0, dry):
    """«ЖК Светлый», «мкр Академический» из названий найденных чатов — в ключевики."""
    names = []
    for c in chats or []:
        for m in NAME_RE.finditer(str(getattr(c, "title", "") or "")):
            kind = m.group(1).replace(".", "")
            q = good_query(f"{'ЖК' if kind.upper() == 'ЖК' else kind} {m.group(2)}")
            if q:
                names.append(q)
    if not names or dry:
        return []
    cur = enrich.read_json(enrich.KEYWORDS, {})
    if cur.get("at") != at0:
        return []
    have = {str(i.get("q", "")).lower() for i in cur.get("items", [])}
    new = [q for q in dict.fromkeys(names) if q.lower() not in have][:max(0, KW_LIMIT - len(have))]
    if new:
        cur["items"] = cur.get("items", []) + [{"q": q, "done": False, "found": 0, "from": "названия чатов"}
                                               for q in new]
        enrich.write_json(enrich.KEYWORDS, cur)
    return new


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
        good = await screen(client, topic, cands, known, dry)
        if good is None or good == DOWN:
            if good is None and not dry:
                bump_seed_fail(key)
            return added, 0, "errors"
        level = int(seed.get("level") or 0) + 1
        got = 0 if dry else enrich.add_chats(
            [{**{k: c[k] for k in QUEUE_KEYS if k in c}, "level": level} for c in good],
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
    # снежный ком добавляет ключевики по ходу — список берём заново каждый заход
    todo = [i for i in kw.get("items", []) if not i.get("done")]
    if not todo and not enrich.similar_seeds():
        say("искать нечего: ключевики пройдены, похожие на все каналы уже проверены")
        tglib.state(done=0, left=0)
        return
    say(f"тема: {topic} · ключевиков осталось {len(todo)}, за этот заход до {per_run}; "
        f"каналов, у которых проверим похожие: {len(enrich.similar_seeds())}")

    client = await tglib.connect(acc)
    known = {str(v.get("chat_id")) for v in enrich.load_chats().values() if v.get("chat_id")}
    known |= set(enrich.read_json(REJECTED, {}))
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
            snow = snowball(res.chats, at0, dry)
            if snow:
                say(f"    из названий чатов — новые ключевики: {', '.join(snow)}")
            good = await screen(client, topic, cands, known, dry)
            if good is None or good == DOWN:
                # модель ответила, но непонятно, — дважды так, и ключевик пропускаем;
                # простой модели ключевику не засчитываем
                if good is None and not dry:
                    bump_fit_fail(item["q"], at0)
                stop = "errors"
                break
            got = 0 if dry else enrich.add_chats(
                [{k: c[k] for k in QUEUE_KEYS if k in c} for c in good],
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
