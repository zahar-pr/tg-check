#!/usr/bin/env python3
"""
Разбор выкачанного чата моделью — по каждому автору отдельно.

Для автора берём все его сообщения и по 10 соседних до и после каждого, даже
чужих: смысл часто живёт в чужой реплике. «А ты хату брать будешь?» — «да» —
ключевых слов у второго нет, а квартиру он хочет. И наоборот: «@chmo: беру
новостройку» — «@mraz: и я тоже» — у @mraz своя очередь разбора, и в его окне
будет реплика @chmo. Пересекающиеся окна сливаем, чтобы модель не читала одно
дважды.

Модель отвечает: лид или нет, почему, и заметку в свободной форме — всё, что
о человеке видно (кем работает, район, бюджет, сроки, ипотека, семья…).
В leads.json попадают только лиды.

Разобрал чат до конца — сырые сообщения удаляем, чат отмечается done.
Прервали — прогресс по авторам лежит в enrich/progress, продолжим с места.
Модели в работе нужен только интернет, Telegram и аккаунт не нужны.

    python enrich-analyze.py                     # следующий выкачанный чат
    python enrich-analyze.py --chat <ключ>
    python enrich-analyze.py --sample file.jsonl --dry   # песок: только печать
"""
import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import enrich
import llm
import tglib
from tglib import say

AROUND = 10               # соседних сообщений до и после
CHUNK = 12000             # столько символов окна за один запрос к модели
WORKERS = 4               # запросов к модели одновременно
FAILS_STOP = 6            # подряд не ответила модель — останавливаемся, чат ждёт

SYSTEM = """Ты разбираешь переписку из Telegram-чата и ищешь людей, которые {goal}.

Тебе дают ОДНОГО участника — ЦЕЛЬ. Его сообщения помечены ►, вокруг по 10
соседних сообщений других людей. Формат строки: #id [дата] @ник (имя): текст,
«↩#id» — ответ на сообщение с этим id.

Реши, относится ли ЦЕЛЬ к тем, кто {goal}. Читай смысл и контекст, а не ключевые слова:
- короткий ответ ЦЕЛИ («да», «+», «и я тоже», «тоже ищу», «интересует») на чужой
  вопрос или реплику по теме — это интерес ЦЕЛИ, хотя ключевых слов у неё нет;
- вопросы «для себя» по теме (цены, условия, сроки, где выбрать) — скорее интерес;
- НЕ лид: те, кто сам продаёт или предлагает это за деньги (продавцы, агенты,
  посредники, реклама, боты); кто уже получил своё и просто делится; кто
  обсуждает тему без своего намерения; кто спрашивает за другого без интереса;
- если в цели есть место (город, район), а человек явно хочет в другом месте —
  не лид.

score — уверенность от 0 до 100, что ЦЕЛЬ относится к тем, кто {goal}:
90+ прямо говорит о своём намерении; 60–89 — намерение видно из контекста;
ниже 60 — догадки. Сомневаешься — lead=false.

Ответь СТРОГО одним JSON без пояснений вокруг:
{{"lead": true|false, "score": 0-100, "why": "одна короткая фраза",
  "facts": {{"поле": "значение"}}, "note": "заметка"}}

facts — только для лида: короткие факты о человеке, полезные для личного
письма. Поля по смыслу цели, например: «что ищет», «город», «район», «бюджет»,
«сроки», «способ оплаты», «работа», «семья», «откуда», «что важно»,
«возражения», «как связаться». Только то, что видно из переписки, без догадок;
неизвестное не пиши вовсе.
note — только для лида, в markdown: всё, что видно о человеке, плюс 1–3
короткие цитаты с датой. Чего нет — не выдумывай."""

MIN_SCORE = 60          # ниже — не лид: релевантность важнее количества


def line(m, me):
    who = f"@{m['un']}" if m.get("un") else f"id{m['uid']}"
    name = f" ({m['name']})" if m.get("name") else ""
    reply = f" ↩#{m['reply_to']}" if m.get("reply_to") else ""
    mark = "►" if m.get("uid") == me else " "
    text = " ".join(str(m.get("text") or "").split())[:1200]
    return f"{mark} #{m['id']} [{str(m.get('date', ''))[:16].replace('T', ' ')}] {who}{name}{reply}: {text}"


def windows(pos, total):
    """Позиции сообщений автора -> слитые отрезки [a, b] с соседями."""
    out = []
    for p in sorted(pos):
        a, b = max(0, p - AROUND), min(total - 1, p + AROUND)
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def chunks(msgs, spans, me):
    """
    Отрезки -> тексты для модели не длиннее CHUNK; разрыв между отрезками — «…».
    Автор, который пишет часто, сливает окна в один длинный отрезок — его режем
    по строкам, а не обрезаем: иначе свежие реплики самых активных людей до
    модели не доходили бы вовсе. Кусок без единой реплики автора не нужен.
    """
    blocks = []
    for a, b in spans:
        cur, size = [], 0
        for m in msgs[a:b + 1]:
            ln = line(m, me)
            if cur and size + len(ln) + 1 > CHUNK:
                blocks.append(cur)
                # контекст на стыке — последние строки куска, но не больше трети
                # куска: иначе длинные сообщения дали бы запрос на каждую реплику
                tail = []
                for x in reversed(cur[-AROUND:]):
                    if sum(len(y) + 1 for y in tail) + len(x) + 1 > CHUNK // 3:
                        break
                    tail.insert(0, x)
                cur, size = tail, sum(len(y) + 1 for y in tail)
            cur.append(ln)
            size += len(ln) + 1
        if cur:
            blocks.append(cur)
    blocks = [bl for bl in blocks if any(x.startswith("►") for x in bl)]
    parts, cur, size = [], [], 0
    for bl in blocks:
        text = "\n".join(bl)
        if cur and size + len(text) > CHUNK:
            parts.append("\n…\n".join(cur))
            cur, size = [], 0
        cur.append(text)
        size += len(text)
    if cur:
        parts.append("\n…\n".join(cur))
    return parts


def _clean(d):
    """Вердикт из словаря модели: lead, score 0–100, why, facts (строка -> строка), note."""
    lead = d.get("lead") is True or str(d.get("lead")).lower() == "true"
    try:
        score = max(0, min(100, int(float(d.get("score")))))
    except (TypeError, ValueError):
        score = 70 if lead else 0
    facts = {}
    if isinstance(d.get("facts"), dict):
        for k, v in d["facts"].items():
            k, v = " ".join(str(k).split())[:40], " ".join(str(v).split())[:300]
            if k and v and v.lower() not in ("нет", "неизвестно", "-", "—", "null", "none"):
                facts[k] = v
    return {"lead": lead, "score": score, "why": str(d.get("why") or "")[:300],
            "facts": facts, "note": str(d.get("note") or "")}


# strict=False: заметку в markdown модели пишут с настоящими переносами строк
# прямо внутри JSON-строки — строгий разбор счёл бы такой ответ мусором
_DEC = json.JSONDecoder(strict=False)


def verdict(out, final=True):
    """
    JSON-вердикт из ответа модели. Модели с рассуждениями пишут ход мыслей
    прямо в ответ (TECH-BASE.md, §8), там бывают и черновые вердикты — поэтому
    в счёт идёт только ПОСЛЕДНИЙ объект, который начинается с "lead" (внутри
    него бывают вложенные facts — регулярка их не осилит). Строку формата из
    промпта («true|false») вердиктом не считаем.

    Последний объект не закрыт — ответ обрезан по токенам. Если это не последняя
    попытка (final=False), вернём None: ask() повторит с запасом. На последней
    спасаем что успели: lead, score, why, facts (они идут до заметки и обычно
    целы) и начало заметки. Лид без целой оценки не спасаем — уверенности нет.
    """
    out = out or ""
    starts = list(re.finditer(r'\{\s*"lead"\s*:\s*(true|false)\b(?!\s*\|)', out))
    if not starts:
        return None
    m = starts[-1]
    try:
        d, _ = _DEC.raw_decode(out, m.start())
        if isinstance(d, dict) and "lead" in d:
            return _clean(d)
    except ValueError:
        pass
    if not final:
        return None
    def field(name):
        f = re.compile(r'"%s"\s*:\s*"((?:[^"\\]|\\.)*)' % name, re.S).search(out, m.end())
        return f.group(1).replace("\\n", "\n") if f else ""
    lead = m.group(1) == "true"
    sc = re.compile(r'"score"\s*:\s*(\d+)\s*[,}\s]').search(out, m.end())   # «9» от обрезанного «90» не в счёт
    if lead and not sc:
        return None
    facts = None
    f = re.compile(r'"facts"\s*:\s*(?=\{)').search(out, m.end())
    if f:
        try:
            facts, _ = _DEC.raw_decode(out, f.end())
        except ValueError:
            pass
    note = field("note")
    return _clean({"lead": lead, "score": sc.group(1) if sc else 0, "why": field("why"),
                   "facts": facts, "note": (note + " …") if note else ""})


class Fail:
    """
    Вердикта нет. kind:
      "out" — модель недоступна (сеть, перегрузка, деньги, ключ): повторим позже,
              это не вина автора;
      "bad" — ответила, но без вердикта и после повтора с запасом токенов;
      "req" — отказала в самом запросе (400/413: длинно, не понравился текст —
              или неверный ID модели, это решает проверка модели в main).
    code — код сбоя от llm.chat (net, 402, 503…).
    """

    def __init__(self, kind, code=""):
        self.kind, self.code = kind, code


# коды, после которых модель недоступна ВСЕМ, а не одному автору: деньги, ключ,
# доступ, перегрузка, ошибка без кода. Такие сбои авторам не засчитываем
ACCOUNT_CODES = {"401", "402", "403", "429", ""}


def ask(system, text):
    """Вердикт модели по одному куску окон — или Fail."""
    budgets = (1200, 2500)
    for n, tokens in enumerate(budgets):
        info = {}
        out = llm.chat(system, text, max_tokens=tokens, temperature=0.2, info=info)
        if out is None:
            code = str(info.get("code", ""))
            return Fail("req" if code in ("400", "413") else "out", code)
        v = verdict(out, final=n == len(budgets) - 1)
        if v:
            return v
    return Fail("bad")


def model_alive():
    """
    Короткая проверка: жива ли модель вообще. Тот же запас токенов, что у
    настоящих запросов: при почти пустом балансе OpenRouter пропускает
    крошечный запрос и отказывает обычным (402 «можете позволить N токенов»).
    """
    info = {}
    out = llm.chat("Ответь одним словом.", "ок", max_tokens=900, temperature=0, info=info)
    return out is not None


def judge(system, msgs, me):
    """Автор целиком: лид, если хоть один кусок его окон говорит «да»."""
    pos = [i for i, m in enumerate(msgs) if m.get("uid") == me]
    verdicts = []
    for part in chunks(msgs, windows(pos, len(msgs)), me):
        v = ask(system, part)
        if isinstance(v, Fail):
            return v
        verdicts.append(v)
    # лид — если хоть один кусок уверенно говорит «да» (score не ниже MIN_SCORE)
    yes = [v for v in verdicts if v["lead"] and v["score"] >= MIN_SCORE]
    if not yes:
        best = max(verdicts, key=lambda v: v["score"]) if verdicts else {"why": "", "score": 0}
        return {"lead": False, "score": best["score"], "why": best["why"], "note": ""}
    facts = {}
    for v in yes:                       # факты из всех кусков, поздние уточняют ранние
        facts.update(v["facts"])
    top = max(yes, key=lambda v: v["score"])
    return {"lead": True, "score": top["score"], "why": top["why"], "facts": facts,
            "note": "\n\n".join(v["note"] for v in yes if v["note"]),
            "msg_ids": [msgs[i]["id"] for i in pos],
            "quotes": [str(msgs[i].get("text"))[:200] for i in pos[-3:]]}


def load(path):
    msgs = []
    seen = set()
    with Path(path).open(encoding="utf-8") as f:
        for raw in f:
            try:
                m = json.loads(raw)
            except Exception:
                continue
            if m.get("id") in seen:
                continue
            seen.add(m.get("id"))
            msgs.append(m)
    msgs.sort(key=lambda m: m["id"])
    return msgs


def next_chat():
    chats = enrich.load_chats()
    for status in ("analyzing", "downloaded"):     # недоразобранный — первым
        for k, v in chats.items():
            if v.get("status") == status:
                return k, v
    return None, None


def main():
    dry = tglib.flag("dry")
    sample = tglib.arg("sample", "")
    workers = int(tglib.arg("workers", 0) or 0) or WORKERS
    if sample:
        key, ch, path = "sample", {"title": Path(sample).name, "chat_id": "sample", "ref": ""}, Path(sample)
    else:
        want = tglib.arg("chat", "")
        key, ch = (want, enrich.load_chats().get(want)) if want else next_chat()
        if not ch:
            say("выкачанных чатов нет — разбирать нечего")
            tglib.state(done=0, left=0)
            return
        path = enrich.raw_path(ch.get("chat_id"))
        if not path.exists():
            enrich.set_chat(key, status="error", err="нет файла с сообщениями — перечитать")
            say(f"нет файла {path.name} — чат надо перечитать")
            tglib.state(done=0, left=0)
            return
        enrich.set_chat(key, status="analyzing")

    msgs = load(path)
    authors = {}
    for m in msgs:
        if m.get("uid"):
            authors.setdefault(m["uid"], m)
    for m in msgs:                                  # свежий ник и имя — из последнего
        if m.get("uid"):
            authors[m["uid"]] = m
    title = ch.get("title") or ch.get("ref") or key
    say(f"▸ {title}: сообщений {len(msgs)}, авторов {len(authors)}")
    say(f"цель: {enrich.goal()}")
    system = SYSTEM.format(goal=enrich.goal())

    prog_file = enrich.progress_path(ch.get("chat_id"))
    progress = {} if dry else enrich.read_json(prog_file, {})
    todo = [uid for uid in authors if str(uid) not in progress]     # "_out" — служебный ключ, не автор
    if progress:
        say(f"продолжаю: уже разобрано {len(progress)}, осталось {len(todo)}")

    lock = threading.Lock()
    failed = []          # без вердикта (bad/req) — тратят попытку чата
    rejected = set()     # из них — отказ в самом запросе (400/413)
    outage = []          # (uid, код) — модель недоступна, попытку не тратим
    stats = {"done": 0, "leads": sum(1 for k, v in progress.items() if k != "_out" and v is True),
             "fails": 0, "stop": False}
    # Авторы, на которых модель уже трижды «висла», к ней больше не идут — сразу
    # «без вердикта». Иначе, когда их шестеро и больше, они подряд давали бы
    # «модель недоступна» (FAILS_STOP), и чат крутился бы вечно
    outs = progress.get("_out", {})
    stuck_before = [uid for uid in todo if int(outs.get(str(uid), 0)) >= 3]
    if stuck_before:
        failed += stuck_before
        todo = [uid for uid in todo if uid not in stuck_before]

    def one(uid):
        if stats["stop"]:
            return
        v = judge(system, msgs, uid)
        with lock:
            if isinstance(v, Fail) and v.kind == "out":
                outage.append((uid, v.code))
                stats["fails"] += 1
                if stats["fails"] >= FAILS_STOP:
                    stats["stop"] = True
                return
            stats["fails"] = 0
            if isinstance(v, Fail):
                failed.append(uid)
                if v.kind == "req":
                    rejected.add(uid)
                return
            stats["done"] += 1
            a = authors[uid]
            who = f"@{a['un']}" if a.get("un") else f"id{uid} ({a.get('name', '')})"
            if v["lead"]:
                stats["leads"] += 1
                say(f"  ✔ лид {who} ({v['score']}): {v['why']}")
                if dry:
                    say("    " + v["note"].replace("\n", "\n    "))
                else:
                    # read_ref — где сообщения лежат на самом деле (у канала — обсуждение)
                    enrich.add_lead(uid, a.get("un", ""), a.get("name", ""),
                                    {"chat_id": ch.get("chat_id"), "ref": ch.get("read_ref") or ch.get("ref", ""),
                                     "title": title},
                                    v["msg_ids"], v["why"], v["note"], v["quotes"],
                                    facts=v["facts"], score=v["score"])
            if not dry:
                progress[str(uid)] = bool(v["lead"])
                enrich.write_json(prog_file, progress)
            if stats["done"] % 25 == 0:
                say(f"  разобрано {stats['done']} из {len(todo)} · лидов {stats['leads']}")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, todo))

    # Модель жива (другие авторы разобрались или ответила на короткую проверку),
    # а на этих «не отвечает» — значит, дело в них (длинный текст не успевает за
    # таймаут и т.п.). Трижды так — считаем их «без вердикта», иначе один автор
    # держал бы чат и всю очередь. Лежит модель — ждём, авторов не трогаем
    # Сбои уровня всей модели (деньги, ключ, перегрузка) авторам не засчитываем никогда
    personal = [(u, c) for u, c in outage if c not in ACCOUNT_CODES]
    alive = bool(personal) and len(personal) == len(outage) and (stats["done"] > 0 or model_alive())
    if alive:
        outs = progress.setdefault("_out", {})
        stuck = []
        for uid, _ in personal:
            outs[str(uid)] = int(outs.get(str(uid), 0)) + 1
            if outs[str(uid)] >= 3:
                stuck.append(uid)
        if not dry:
            enrich.write_json(prog_file, progress)
        failed += stuck
        outage = [(u, c) for u, c in outage if u not in stuck]
    # Ни одного вердикта, и все отказы — в самом запросе (400): так выглядит не
    # «трудный текст», а сломанная модель (неверный ID, удалили у провайдера).
    # Проверяем: не отвечает и на «ок» — это простой, сырьё не трогаем
    if failed and not stats["done"] and set(failed) <= rejected and not model_alive():
        outage += [(u, "400") for u in failed]
        failed = []
    # Модель недоступна (сеть, 5xx) — чат ждёт, попытка не считается: это не
    # вина авторов. Сырьё не удаляем, прогресс по разобранным сохранён.
    if stats["stop"] or outage:
        say(f"\nстоп: модель недоступна ({llm.LAST_ERR or 'пустой ответ'}) — не разобрано "
            f"{len(todo) - stats['done'] - len(failed)}, чат подождёт и продолжит с этого места")
        if not dry and not sample:
            enrich.set_chat(key, status="downloaded", err=f"модель: {(llm.LAST_ERR or 'не отвечает')[:100]}")
        tglib.state(done=stats["done"], left=len(todo) - stats["done"], stop="errors", cooldown=15 * 60)
        return
    # Модель отвечала, но без вердикта: ещё два захода, потом сдаёмся, чтобы
    # один «трудный» автор не держал очередь вечно
    tries = int(ch.get("tries") or 0) + (1 if failed else 0)
    if failed and tries < 3:
        say(f"\nне разобрано авторов {len(failed)}: модель не дала вердикта — повторю (заход {tries} из 3)")
        if not dry and not sample:
            enrich.set_chat(key, status="downloaded", tries=tries,
                            err=f"модель не дала вердикта{': ' + llm.LAST_ERR[:90] if llm.LAST_ERR else ''}")
        tglib.state(done=stats["done"], left=len(failed), stop="errors", cooldown=5 * 60)
        return
    gave_up = f"модель не разобрала авторов: {len(failed)}" if failed else ""

    say(f"\nитого: авторов {len(authors)} · лидов {stats['leads']}")
    if not dry and not sample:
        # сырые сообщения больше не нужны: всё важное — в карточках лидов
        path.unlink(missing_ok=True)
        prog_file.unlink(missing_ok=True)
        enrich.set_chat(key, status="done", done_at=enrich.now_iso(), msgs=len(msgs),
                        authors=len(authors), leads=stats["leads"], err=gave_up)
    left = sum(1 for v in enrich.load_chats().values() if v.get("status") in ("downloaded", "analyzing"))
    tglib.state(done=stats["leads"], left=left)


main()
