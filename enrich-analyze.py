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

Реши, относится ли ЦЕЛЬ к тем, кто {goal}. Читай контекст, а не ключевые слова:
- короткий ответ «да», «+», «и я тоже», «тоже ищу», «интересует» на вопрос или
  реплику про покупку — это интерес ЦЕЛИ;
- вопросы про ипотеку, планировки, сдачу дома, застройщика, район «для себя» —
  скорее интерес;
- НЕ лид: риелторы, агенты, застройщики, продавцы, реклама, боты; те, кто уже
  купил и просто делится (если не ищет ещё); обсуждение цен без намерения;
  те, кто продаёт или сдаёт своё жильё.
Сомневаешься — lead=false.

Ответь СТРОГО одним JSON без пояснений вокруг:
{{"lead": true|false, "why": "одна короткая фраза", "note": "заметка"}}

note — только для лида, в markdown: всё, что видно о человеке. Имя, чем
занимается и кем работает, район и ЖК, бюджет, комнатность, сроки, ипотека
или наличные, семья и дети, откуда переезжает, что для него важно, как
связаться, плюс 1–3 короткие цитаты с датой. Чего нет — не выдумывай."""


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
                cur, size = cur[-AROUND:], sum(len(x) + 1 for x in cur[-AROUND:])  # контекст на стыке
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


def verdict(out):
    """
    JSON-вердикт из ответа модели. Модели с рассуждениями пишут ход мыслей
    прямо в ответ (TECH-BASE.md, §8), и фигурные скобки бывают и там — поэтому
    берём ПОСЛЕДНИЙ объект с полем lead, а не первый попавшийся.
    """
    found = None
    for m in re.finditer(r"\{[^{}]*\"lead\"[^{}]*\}", out or "", re.S):
        try:
            d = json.loads(m.group(0))
        except Exception:
            continue
        if isinstance(d, dict) and "lead" in d:
            found = d
    if found is None:
        return None
    return {"lead": found.get("lead") is True or str(found.get("lead")).lower() == "true",
            "why": str(found.get("why") or "")[:300], "note": str(found.get("note") or "")}


def ask(system, text):
    """Вердикт модели. None — модель не ответила толком (повторим позже)."""
    for _ in range(2):
        out = llm.chat(system, text, max_tokens=900, temperature=0.2)
        if out is None:
            return None
        v = verdict(out)
        if v:
            return v
    return None


def judge(system, msgs, me):
    """Автор целиком: лид, если хоть один кусок его окон говорит «да»."""
    pos = [i for i, m in enumerate(msgs) if m.get("uid") == me]
    verdicts = []
    for part in chunks(msgs, windows(pos, len(msgs)), me):
        v = ask(system, part)
        if v is None:
            return None
        verdicts.append(v)
    yes = [v for v in verdicts if v["lead"]]
    if not yes:
        return {"lead": False, "why": verdicts[0]["why"] if verdicts else "", "note": ""}
    return {"lead": True, "why": yes[0]["why"], "note": "\n\n".join(v["note"] for v in yes if v["note"]),
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
    todo = [uid for uid in authors if str(uid) not in progress]
    if progress:
        say(f"продолжаю: уже разобрано {len(progress)}, осталось {len(todo)}")

    lock = threading.Lock()
    failed = []
    stats = {"done": 0, "leads": sum(1 for v in progress.values() if v), "fails": 0, "stop": False}

    def one(uid):
        if stats["stop"]:
            return
        v = judge(system, msgs, uid)
        with lock:
            if v is None:
                failed.append(uid)
                stats["fails"] += 1
                if stats["fails"] >= FAILS_STOP:
                    stats["stop"] = True
                return
            stats["fails"] = 0
            stats["done"] += 1
            a = authors[uid]
            who = f"@{a['un']}" if a.get("un") else f"id{uid} ({a.get('name', '')})"
            if v["lead"]:
                stats["leads"] += 1
                say(f"  ✔ лид {who}: {v['why']}")
                if dry:
                    say("    " + v["note"].replace("\n", "\n    "))
                else:
                    # read_ref — где сообщения лежат на самом деле (у канала — обсуждение)
                    enrich.add_lead(uid, a.get("un", ""), a.get("name", ""),
                                    {"chat_id": ch.get("chat_id"), "ref": ch.get("read_ref") or ch.get("ref", ""),
                                     "title": title},
                                    v["msg_ids"], v["why"], v["note"], v["quotes"])
            if not dry:
                progress[str(uid)] = bool(v["lead"])
                enrich.write_json(prog_file, progress)
            if stats["done"] % 25 == 0:
                say(f"  разобрано {stats['done']} из {len(todo)} · лидов {stats['leads']}")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, todo))

    # Модель не дала вердикта по части авторов — сырьё не удаляем: следующий
    # заход разберёт только их (прогресс по остальным сохранён). После
    # нескольких заходов сдаёмся, чтобы один «трудный» автор не держал очередь
    tries = int(ch.get("tries") or 0) + 1
    if stats["stop"] or (failed and tries < 3):
        say(f"\nстоп: не разобрано авторов {len(todo) - stats['done']} "
            f"({llm.LAST_ERR or 'модель не дала вердикта'}) — чат подождёт, разбор продолжится с этого места")
        if not dry and not sample:
            enrich.set_chat(key, status="downloaded", tries=tries,
                            err=f"модель: {(llm.LAST_ERR or 'нет вердикта')[:100]}")
        tglib.state(done=stats["done"], left=len(todo) - stats["done"], stop="errors", cooldown=15 * 60)
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
