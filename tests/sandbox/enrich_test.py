"""
Песочница обогащения: читатель, разбор по авторам и письмо лиду без @username —
настоящие скрипты, подменённые Telegram и модель. Сеть не нужна.

    python tests/sandbox/enrich_test.py          # нужен Telethon (venv-tg)

Что проверяем:
  • enrich-read: берёт чат из очереди, вступает, читает пачками до границы
    90 дней, ботов и служебные отбрасывает, выходит из чата, статус downloaded;
  • enrich-analyze: окна ±10 соседних — «да» в ответ на «хату берёшь?» делает
    лидом без ключевых слов, «и я тоже» рядом с чужой репликой — тоже; лиды
    в leads.json и в очереди рассылки, сырьё удалено, чат done;
  • повторный запуск разбора не трогает уже разобранный чат;
  • писатель находит лида без @username через его сообщение (InputUserFromMessage),
    tglib.can_write отдаёт такого лида любому аккаунту.
"""
import asyncio
import json
import time
import os
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
TMP = Path(tempfile.mkdtemp(prefix="enrich-sandbox-"))
os.environ["TG_PANEL_DIR"] = str(TMP)
os.environ["TG_SET"] = "chats"
sys.path.insert(0, str(REPO))

import enrich  # noqa: E402
import llm     # noqa: E402
import tglib   # noqa: E402
from telethon import functions, types  # noqa: E402

FAILS = []


def check(ok, what):
    print(("  ok  " if ok else "  FAIL ") + what)
    if not ok:
        FAILS.append(what)


NOW = datetime.now(timezone.utc)
CHAT_ID = 777
USERS = {
    1: ("chmo", "Иван"), 2: ("mraz", "Пётр"), 3: ("vasya", "Вася"), 4: ("", "Оля"),
    5: ("rieltor_ekb", "Агент"), 6: ("bot_helper", "Бот"),
}


def u(uid):
    un, name = USERS[uid]
    return types.User(id=uid, username=un or None, first_name=name, bot=(uid == 6), access_hash=uid * 10)


# (uid, текст, дней назад, ответ на id) — история чата от старых к новым
SCRIPT = [
    (3, "всем привет, кто где живёт?", 100, None),          # за границей 90 дней — не читается
    (5, "Продаю двушку в Академическом, пишите в лс", 40, None),
    (1, "буду щас новостройку брать в Академическом, ипотека 6%", 30, None),
    (2, "да, и я тоже", 30, None),
    (3, "погода сегодня отличная", 29, None),
    (6, "Я бот, нажмите кнопку", 29, None),
    (3, "Оль, а ты хату брать будешь?", 20, None),
    (4, "да", 20, None),
    (3, "ну ладно, удачи", 19, None),
]
for i in range(30):                                        # шум: чтобы были пачки по 100 и окна
    SCRIPT.insert(4, (3, f"болтовня {i}", 35 - i % 5, None))


class Msg:
    def __init__(self, mid, uid, text, days):
        self.id, self.message, self.action = mid, text, None
        self.date = NOW - timedelta(days=days)
        self.sender = u(uid)
        self.sender_id = uid
        self.reply_to = None


MSGS = [Msg(i + 1, uid, text, days) for i, (uid, text, days, _) in enumerate(SCRIPT)]
GROUP = types.Channel(id=CHAT_ID, title="ЖК Академ — соседи", photo=types.ChatPhotoEmpty(),
                      date=NOW, megagroup=True, username="akadem_sosedi", left=True, access_hash=5)
# канал застройщика, чья группа обсуждения — та же GROUP: лиды «из комментариев»
CHANNEL = types.Channel(id=888, title="Академ — новости", photo=types.ChatPhotoEmpty(),
                        date=NOW, broadcast=True, username="akadem_news", left=True, access_hash=6)


def chan(cid, un, title, broadcast=True, has_link=True, join_request=False, n=500):
    return types.Channel(id=cid, title=title, photo=types.ChatPhotoEmpty(), date=NOW, username=un,
                         broadcast=broadcast, megagroup=not broadcast, has_link=has_link,
                         join_request=join_request, participants_count=n, access_hash=cid)


# поиск по ключевику и «похожие каналы» для песка поиска
SEARCH = [chan(901, "akadem_news2", "Академ — новости 2"), chan(902, "akadem_group", "Академ чат", broadcast=False)]
SIMILAR = {
    "akadem_news2": [chan(903, "rec_one", "Похожий 1"), chan(904, "rec_nolink", "Без комментариев", has_link=False),
                     chan(905, "rec_req", "По заявке", join_request=True)],
    "rec_one": [chan(906, "rec_two", "Похожий 2")],
}
BY_NAME = {c.username: c for c in SEARCH + [x for v in SIMILAR.values() for x in v]}


class Found:
    def __init__(self, chats):
        self.chats = chats


class Full:
    def __init__(self):
        self.full_chat = type("F", (), {"linked_chat_id": CHAT_ID})()
        self.chats = [CHANNEL, GROUP]


class Client:
    """Ровно то, что зовут enrich-read и find_member/via_message."""

    def __init__(self, closed=False):
        self.calls = []
        self.closed = closed                        # снаружи истории не показывают — надо вступить

    async def get_entity(self, ref):
        if ref in ("akadem_sosedi", CHAT_ID):
            return GROUP
        if ref == "akadem_news":
            return CHANNEL
        if ref in BY_NAME:
            return BY_NAME[ref]
        raise ValueError(f"Could not find the input entity for {ref}")

    async def get_input_entity(self, ent):
        if isinstance(ent, str):
            if ent == "stale_name":                  # ник канала теперь у человека
                return types.InputPeerUser(4242, 1)
            ent = BY_NAME.get(ent) or (await self.get_entity(ent))
        return types.InputPeerChannel(ent.id, ent.access_hash)

    async def get_messages(self, entity, limit=None, offset_id=0, ids=None):
        if self.closed and "JoinChannelRequest" not in self.calls and ids is None:
            from telethon.errors import ChannelPrivateError
            raise ChannelPrivateError(request=None)
        if ids is not None:
            return [next((m for m in MSGS if m.id == i), None) for i in ids]
        older = [m for m in reversed(MSGS) if not offset_id or m.id < offset_id]
        self.calls.append(("history", offset_id))
        return older[:limit]

    async def __call__(self, req):
        self.calls.append(type(req).__name__)
        if isinstance(req, functions.channels.GetFullChannelRequest):
            return Full()
        if isinstance(req, functions.contacts.SearchRequest):
            return Found(SEARCH)
        if isinstance(req, functions.channels.GetChannelRecommendationsRequest):
            un = next((c.username for c in BY_NAME.values() if c.id == req.channel.channel_id), "")
            return Found(SIMILAR.get(un, []))
        if isinstance(req, functions.users.GetUsersRequest):
            iu = req.id[0]
            assert isinstance(iu, types.InputUserFromMessage)
            return [u(iu.user_id)]
        return None


def run_script(name, *args, client=None):
    """Скрипт как из панели: argv, подменённые connect/aclose, вывод — в список строк."""
    out = []
    old_say, old_argv = tglib.say, sys.argv

    def say(*a):
        out.append(" ".join(str(x) for x in a))
    tglib.say = say
    if client:
        async def connect(acc, **kw):
            return client

        async def aclose(c):
            return None
        tglib.connect, tglib.aclose = connect, aclose
    real_print = print
    import builtins
    builtins.print = lambda *a, **k: out.append(" ".join(str(x) for x in a))
    sys.argv = [str(REPO / name), *args]
    try:
        runpy.run_path(str(REPO / name), run_name="__main__")
    except SystemExit as e:
        out.append(f"exit {e}")
    finally:
        builtins.print = real_print
        tglib.say, sys.argv = old_say, old_argv
    return out


def fake_llm(system, user, max_tokens=400, temperature=0.8, tries=5, model=None, info=None, **kw):
    """
    «Модель» для песка: смотрит на реплики ЦЕЛИ (►) и на соседние строки. Лид —
    если цель сама говорит про покупку, или отвечает «да»/«и я тоже» сразу
    после реплики про покупку. Рекламу риелтора не берёт. Перед JSON —
    рассуждение со скобками, как у reasoning-моделей.
    """
    lines = user.splitlines()
    buy = re.compile(r"новостройк|хат|квартир|ипотек", re.I)
    lead, why = False, "не про покупку"
    for i, ln in enumerate(lines):
        if not ln.startswith("►"):
            continue
        text = ln.split(": ", 1)[-1]
        if "Продаю" in text:
            lead, why = False, "продаёт"
            break
        if buy.search(text) and not text.rstrip().endswith("?"):
            lead, why = True, "сам пишет про покупку"
        elif re.fullmatch(r"(да|\+|и я тоже|да, и я тоже)[.!]?", text.strip(), re.I) and i and buy.search(lines[i - 1]):
            lead, why = True, "ответил «да» на вопрос про покупку"
    note = "- район: Академический\n- ипотека" if lead else ""
    facts = {"район": "Академический", "оплата": "ипотека"} if lead else {}
    # «Вася» спрашивает про хату — для песка это слабый интерес: оценка ниже порога
    score = 85 if lead else (40 if "хату брать будешь" in user else 5)
    return ("Думаю {вслух}: смотрю на ► …\n" +
            json.dumps({"lead": lead or score == 40, "score": score, "why": why, "facts": facts, "note": note},
                       ensure_ascii=False))


def NAME_TEST(ns, title):
    return [m.group(0) for m in ns["NAME_RE"].finditer(title)]


def main():
    acc = {"id": "r1", "title": "читатель", "dir": "accounts/r1"}
    (TMP / "accounts.json").write_text(json.dumps([acc]), "utf-8")
    enrich.write_json(enrich.STATE, {"on": True})

    print("\n▸ очередь")
    n = enrich.add_chats(["t.me/akadem_sosedi", "@AKADEM_SOSEDI", "t.me/+Invite123"])
    check(n == 2, f"дубль по ссылке отсечён (добавлено {n} из 3)")

    print("\n▸ читатель: сбой подключения")
    real_connect = tglib.connect

    async def broken(acc, **kw):
        raise SystemExit("выход прокси не из Казахстана")
    tglib.connect = broken
    run_script("enrich-read.py", "--account", "r1")
    tglib.connect = real_connect
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "new" and ch["reader"] == "r1", f"не подключился — чат вернулся в очередь: {ch['status']}")

    print("\n▸ читатель")
    c = Client()
    out = run_script("enrich-read.py", "--account", "r1", client=c)
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "downloaded", f"чат выкачан: {ch['status']}")
    check("JoinChannelRequest" not in c.calls, "публичную группу прочитал снаружи — вступление не потратил")
    raw = [json.loads(x) for x in enrich.raw_path(CHAT_ID).read_text("utf-8").splitlines()]
    check(all(m["uid"] != 6 for m in raw), "бот отброшен")
    check(all("всем привет" not in m["text"] for m in raw), "сообщения старше 90 дней не читаются")
    check(ch["msgs"] == len(raw) == len(SCRIPT) - 2, f"сообщений {ch['msgs']} (ожидалось {len(SCRIPT) - 2})")
    check(enrich.joins_today("r1") == 0, "вступлений 0")

    print("\n▸ читатель: снаружи не показывают — вступает и потом выходит")
    enrich.set_chat("akadem_sosedi", status="new", reader="")
    enrich.raw_path(CHAT_ID).unlink()
    c = Client(closed=True)
    run_script("enrich-read.py", "--account", "r1", client=c)
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "downloaded" and "JoinChannelRequest" in c.calls and "LeaveChannelRequest" in c.calls
          and enrich.joins_today("r1") == 1, f"вступил, прочитал, вышел, вступление посчитано: {ch['status']}")

    print("\n▸ читатель: большой чат — поиском по теме внутри, с соседями и ответами")
    ns_r = {"__name__": "read_test"}
    src_r = (REPO / "enrich-read.py").read_text("utf-8").rsplit("\nasyncio.run(main())", 1)[0]
    exec(compile(src_r, "enrich-read.py", "exec"), ns_r)
    post_ch = types.Channel(id=990, title="ЛСР Екатеринбург", photo=types.ChatPhotoEmpty(), date=NOW,
                            broadcast=True, username="lsr_ekb", access_hash=9)

    class BigMsg:
        def __init__(self, mid, uid, text, days, reply=None, replies=0):
            self.id, self.message, self.action = mid, text, None
            self.date = NOW - timedelta(days=days)
            self.sender = post_ch if uid == 0 else types.User(id=uid, first_name=f"U{uid}", access_hash=uid)
            self.sender_id = -990 if uid == 0 else uid
            self.reply_to = types.MessageReplyHeader(reply_to_msg_id=reply) if reply else None
            self.replies = types.MessageReplies(replies=replies, replies_pts=0) if replies else None
    big = {i: BigMsg(i, 500 + i % 7, f"болтовня {i}", 60 - i // 6) for i in range(1, 321)}
    big[150] = BigMsg(150, 3, "Оль, а ты хату брать будешь?", 30, replies=1)
    big[151] = BigMsg(151, 4, "да", 30, reply=150)
    big[220] = BigMsg(220, 0, "ЖК Светлый: старт продаж! Пишите в комментарии — скинем цены", 20, replies=2)
    big[300] = BigMsg(300, 77, "подробности", 9, reply=220)
    big[310] = BigMsg(310, 78, "сколько стоит двушка?", 8, reply=220)

    class BigClient:
        async def get_messages(self, entity, limit=None, ids=None, **kw):
            if ids is not None:
                return [big.get(i) for i in ids]
            return [big[i] for i in sorted(big, reverse=True)][:limit]

        async def iter_messages(self, entity, search=None, limit=None, reply_to=None):
            n = 0
            for i in sorted(big, reverse=True):
                m = big[i]
                if search and search not in m.message.lower():
                    continue
                if reply_to and getattr(m.reply_to, "reply_to_msg_id", None) != reply_to:
                    continue
                n += 1
                if limit and n > limit:
                    return
                yield m
    enrich.add_chats([{"ref": "t.me/big_city", "chat_id": 779, "title": "Екатеринбург чат"}])
    ns_r["PAUSE"] = (0, 0)
    done, msg = asyncio.run(ns_r["search_read"](BigClient(), None, "big_city", enrich.raw_path(779),
                                                NOW - timedelta(days=90), ["хат", "жк", "кварти"]))
    got = {json.loads(x)["id"] for x in enrich.raw_path(779).read_text("utf-8").splitlines()}
    check(done and {150, 151, 220, 300, 310} <= got and len(got) < 60,
          f"находки с соседями и ответами, без остального чата: {sorted(got)[:12]}… всего {len(got)} — {msg}")
    check(enrich.load_chats()["big_city"].get("read_mode") == "поиск", "в очереди видно, что чат прочитан поиском")
    ns_r["HITS_MAX"] = 20
    done, msg = asyncio.run(ns_r["search_read"](BigClient(), None, "big_city", enrich.raw_path(779),
                                                NOW - timedelta(days=90), ["болтов", "хат", "жк"]))
    got = {json.loads(x)["id"] for x in enrich.raw_path(779).read_text("utf-8").splitlines()}
    check({150, 151, 220, 300, 310} <= got, f"частый корень («болтов», 300 находок) не вытеснил редкие: {msg}")
    other = types.Message(id=5, peer_id=types.PeerChannel(779), message="да", date=NOW,
                          reply_to=types.MessageReplyHeader(reply_to_msg_id=3, reply_to_peer_id=types.PeerChannel(42)))
    same = types.Message(id=6, peer_id=types.PeerChannel(779), message="да", date=NOW,
                         reply_to=types.MessageReplyHeader(reply_to_msg_id=3))
    check(ns_r["reply_id"](other) is None and ns_r["reply_id"](same) == 3,
          "цитата из другого чата — не ответ на сообщение этого чата")
    enrich.set_chat("big_city", status="done")         # дальше в песке разбирают только «Академ»
    enrich.raw_path(779).unlink()

    print("\n▸ читатель: вступления кончились — чат «только со вступлением» ждёт, остальные читаются")
    enrich.add_chats([{"ref": "t.me/need_join", "chat_id": 780, "title": "Закрытая снаружи"}])
    enrich.set_chat("need_join", needs_join=True)
    for _ in range(enrich.JOIN_MAX):
        enrich.note_join("r9")
    taken = []
    while True:
        k, _ = enrich.pick_chat("r9")
        if not k:
            break
        taken.append(k)
        enrich.set_chat(k, status="done")
    check("need_join" not in taken and enrich.load_chats()["need_join"]["status"] == "new",
          f"читатель без вступлений не берёт чат, который без вступления не прочитать: взял {taken}")
    enrich.set_chat("need_join", status="done")
    for k in taken:                                     # дальше в песке эти чаты ещё нужны
        enrich.set_chat(k, status="new", reader="", read_by=[])
    check(any(o.startswith(tglib.STATE_MARK) for o in out), "отчёт ⌁STATE в конце")
    # второй читатель возьмёт уже другой чат — не тот же
    k2, ch2 = enrich.pick_chat("r2")
    check(k2 == "+Invite123", f"второй читатель получил другой чат: {k2}")
    # процесс r2 «умер»: панель возвращает его чат в очередь
    enrich.set_chat(k2, pid=2 ** 22 + 12345)           # такого процесса нет
    res = subprocess.run([sys.executable, str(REPO / "enrich.py"), "release", k2, "r2"],
                         capture_output=True, text=True, env={**os.environ})
    check(enrich.load_chats()[k2]["status"] == "new" and '"n": 1' in res.stdout, "осиротевший чат вернулся в очередь")
    k3, _ = enrich.pick_chat("r2")                     # этот процесс жив (pid — наш)
    res = subprocess.run([sys.executable, str(REPO / "enrich.py"), "release", k3, "r2"],
                         capture_output=True, text=True, env={**os.environ})
    check(enrich.load_chats()[k3]["status"] == "reading", "чат живого читателя панель не трогает")
    enrich.set_chat(k3, status="new", reader="")

    print("\n▸ разбор: модель недоступна")

    def down(system, user, info=None, **kw):
        if info is not None:
            info["code"] = "net"
        return None
    llm.chat = down
    run_script("enrich-analyze.py")
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "downloaded" and not ch.get("tries"), f"сеть легла — ждём, попытку не тратим: tries {ch.get('tries')}")

    def broke(system, user, info=None, **kw):
        if info is not None:
            info["code"] = "402"                      # кончились деньги на OpenRouter
        return None
    llm.chat = broke
    for _ in range(3):
        run_script("enrich-analyze.py")
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "downloaded" and not ch.get("tries") and enrich.raw_path(CHAT_ID).exists(),
          "кончились деньги (402) — три захода, ни попытки, ни потери сырья")

    def wrong_model(system, user, info=None, **kw):
        if info is not None:
            info["code"] = "400"                      # «x is not a valid model ID» — и на проверку тоже
        return None
    llm.chat = wrong_model
    for _ in range(3):
        run_script("enrich-analyze.py")
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "downloaded" and not ch.get("tries") and enrich.raw_path(CHAT_ID).exists(),
          "неверный ID модели (400 на всё) — простой, сырьё цело")

    def poor(system, user, info=None, **kw):
        if "(Вася)" in user.split("►", 1)[-1].split("\n", 1)[0]:
            if info is not None:
                info["code"] = "402"                  # денег хватило бы только на короткие
            return None
        return fake_llm(system, user)
    llm.chat = poor
    run_script("enrich-analyze.py")
    prog = enrich.read_json(enrich.progress_path(CHAT_ID), {})
    check("3" not in prog.get("_out", {}), "402 при живых соседях — не вина автора, счётчик «висит» не растёт")
    enrich.progress_path(CHAT_ID).unlink(missing_ok=True)   # дальше — разбор с чистого листа

    print("\n▸ разбор: модель ответила без вердикта")

    def flaky(system, user, info=None, **kw):
        olya = "(Оля)" in user.split("►", 1)[-1].split("\n", 1)[0]
        return "не знаю, что сказать" if olya else fake_llm(system, user)
    llm.chat = flaky
    run_script("enrich-analyze.py")
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "downloaded" and ch.get("tries") == 1, f"чат ждёт повтора: {ch['status']}, tries {ch.get('tries')}")
    check(enrich.raw_path(CHAT_ID).exists(), "сырые сообщения не удалены, пока не разобраны все")
    check("4" not in enrich.read_json(enrich.progress_path(CHAT_ID), {}), "Оля ещё не разобрана")

    print("\n▸ обрезанный ответ модели")
    ns_a = {"__name__": "analyze_test"}
    src_a = (REPO / "enrich-analyze.py").read_text("utf-8").rsplit("\nmain()", 1)[0]
    exec(compile(src_a, "enrich-analyze.py", "exec"), ns_a)
    v = ns_a["verdict"]('думаю {так}\n{"lead": true, "score": 85, "why": "берёт двушку", '
                        '"facts": {"район": "Академ", "бюджет": "7 млн"}, "note": "- **Район:** Академ\\n- бюджет до 7')
    check(v and v["lead"] and "Академ" in v["note"] and v["facts"].get("бюджет") == "7 млн",
          f"лид из обрезанного JSON, факты целы: {v}")
    check(ns_a["verdict"]('{"lead": true, "score": 85, "why": "x", "note": "обрез', final=False) is None,
          "обрезанный ответ не на последней попытке — повтор с запасом токенов")
    v = ns_a["verdict"]('{"lead": true, "score": 9')
    check(v is None, f"лид без целой оценки («9» от «90») не спасаем: {v}")
    v = ns_a["verdict"]('Черновик: {"lead": false, "score": 30, "why": "просто спрашивает"} — но нет.\n'
                        '{"lead": true, "score": 92, "why": "ищет", "facts": {"a": "b"}, "note": "x')
    check(v and v["lead"] and v["score"] == 92, f"черновик в рассуждениях не перебивает итоговый вердикт: {v}")
    v = ns_a["verdict"]('{"lead": true, "score": 90, "why": "ищет", "facts": {"бюджет": "8 млн"}, "note": "- Оля\n- ипотека"}')
    check(v and v["facts"].get("бюджет") == "8 млн" and "ипотека" in v["note"] and "…" not in v["note"],
          f"перенос строки внутри заметки — не мусор: {v}")
    v = ns_a["verdict"]('Формат: {"lead": true|false, "why": "фраза"}. Тут «Продаю двушку» — это риелтор.\n'
                        '{"lead": false, "why": "продаёт", "note": "')
    check(v and v["lead"] is False and v["why"] == "продаёт", f"строка формата из промпта не делает лида: {v}")
    v = ns_a["verdict"]('Формат: {"lead": true|false}. Обрезано на рассуждениях')
    check(v is None, "без настоящего вердикта — None, а не «лид»")

    print("\n▸ разбор: модель «висит» только на одном авторе")

    def slow_one(system, user, info=None, **kw):
        if "(Оля)" in user.split("►", 1)[-1].split("\n", 1)[0]:     # остался последним
            if info is not None:
                info["code"] = "net"                  # таймаут curl на длинном тексте
            return None
        return fake_llm(system, user)
    llm.chat = slow_one
    for _ in range(3):
        run_script("enrich-analyze.py")
    prog = enrich.read_json(enrich.progress_path(CHAT_ID), {})
    ch = enrich.load_chats()["akadem_sosedi"]
    check(prog.get("_out", {}).get("4") == 3 and ch.get("tries", 0) >= 2,
          f"после трёх заходов «висящий» автор — без вердикта, чат не крутится вечно: tries {ch.get('tries')}")
    enrich.set_chat("akadem_sosedi", tries=0)
    prog["_out"] = {}                                  # модель «починили» — Олю разбираем заново
    enrich.write_json(enrich.progress_path(CHAT_ID), prog)

    print("\n▸ разбор по авторам")
    llm.chat = fake_llm
    out = run_script("enrich-analyze.py")
    leads = enrich.load_leads()
    who = {v.get("username") or v.get("name") for v in leads.values()}
    check({"chmo", "mraz", "Оля"} <= who, f"лиды: {sorted(who)}")
    check("rieltor_ekb" not in who and "vasya" not in who, "риелтор и болтун не лиды")
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "done" and ch["leads"] == 3, f"чат done, лидов {ch.get('leads')}")
    check(not enrich.raw_path(CHAT_ID).exists(), "сырые сообщения удалены")
    check(not enrich.progress_path(CHAT_ID).exists(), "прогресс удалён")
    olya = next(v for v in leads.values() if v.get("name") == "Оля")
    check(olya["chats"][0]["msg_ids"] and "Академический" in olya["note"], "у лида msg_id и заметка")
    check(olya.get("facts", {}).get("район") == "Академический" and olya.get("score") == 85,
          f"у лида факты по полям и уверенность: {olya.get('facts')}, {olya.get('score')}")
    check(not any(v.get("username") == "vasya" for v in leads.values()),
          "«да, лид» с уверенностью 40 (ниже порога) в лиды не попал")
    rows = tglib.read_csv(tglib.CHAT_RESULTS)
    keys = {r["phone"] for r in rows}
    check({"@chmo", "@mraz", "id:4"} <= keys, f"лиды в очереди рассылки по чатам: {sorted(keys)}")

    out = run_script("enrich-analyze.py")
    check(any("разбирать нечего" in o for o in out), "повторный разбор не трогает готовый чат")

    print("\n▸ один человек — один ключ в очереди")
    enrich.add_lead(4, "olya_new", "Оля", {"chat_id": 999, "ref": "t.me/other", "title": "Другой чат"},
                    [5], "ещё ищет", "- снова про ипотеку", [])
    keys2 = [r["phone"] for r in tglib.read_csv(tglib.CHAT_RESULTS)]
    check("@olya_new" not in keys2 and keys2.count("id:4") == 1, "появился ник — второго ключа нет")
    check(enrich.load_leads()["4"]["key"] == "id:4" and "id:4" in tglib.lead_refs(), "карточка помнит ключ очереди")
    tglib.add_recipients([{"username": "", "user_id": 77, "name": "Сборщиков"}], by="a1")
    enrich.add_lead(77, "", "Сборщиков", {"chat_id": CHAT_ID, "ref": "t.me/akadem_sosedi", "title": "ЖК"},
                    [5], "ищет", "-", [])
    row77 = next(r for r in tglib.read_csv(tglib.CHAT_RESULTS) if r["phone"] == "id:77")
    check(not tglib.can_write(row77, "w9") and tglib.can_write(row77, "a1"),
          "человека, собранного разбором участников, пишет его сборщик")

    print("\n▸ писатель и лид без @username")
    row = next(r for r in rows if r["phone"] == "id:4")
    check(tglib.can_write(row, "w9"), "лида без ника может взять любой писатель")
    check(not tglib.can_write({"phone": "id:999", "by": "a1"}, "w9"), "чужой id:-человек без лида — нет")
    src = (REPO / "draft-messages.py").read_text("utf-8").rsplit("\ntry:\n    asyncio.run(main())", 1)[0]
    ns = {"__name__": "draft_test"}
    exec(compile(src, "draft-messages.py", "exec"), ns)
    c2 = Client()
    user = asyncio.run(ns["find_member"](c2, "id:4", {"id": "w9", "title": "писатель"}))
    check(getattr(user, "id", None) == 4, "писатель нашёл лида через сообщение в чате")
    check("GetUsersRequest" in c2.calls, "профиль взят через InputUserFromMessage")
    olya_msg = next(m.id for m in MSGS if m.sender_id == 4)
    lead_ch = {"uid": 4, "chats": [{"chat_id": CHAT_ID, "ref": "@akadem_news", "msg_ids": [olya_msg]}]}
    c3 = Client()
    user = asyncio.run(ns["via_message"](c3, lead_ch, {"id": "w9", "title": "писатель"}))
    check(getattr(user, "id", None) == 4 and "GetFullChannelRequest" in c3.calls,
          "лид из комментариев канала — найден в группе обсуждения")

    print("\n▸ разбор: семеро «висящих» авторов не крутят чат вечно")
    stuck_id = 555
    enrich.add_chats([{"ref": "t.me/stuck_chat", "chat_id": stuck_id, "title": "Висящие"}])
    enrich.set_chat("stuck_chat", status="downloaded")
    with enrich.raw_path(stuck_id).open("w", encoding="utf-8") as f:
        for i in range(8):
            f.write(json.dumps({"id": i + 1, "date": NOW.isoformat(), "uid": 900 + i, "un": f"u{i}",
                                "name": f"Автор{i}", "text": "погода норм", "reply_to": None}) + "\n")
    enrich.write_json(enrich.progress_path(stuck_id), {"_out": {str(900 + i): 3 for i in range(7)}})
    calls = []

    def counting(system, user, **kw):
        calls.append(user)
        return fake_llm(system, user)
    llm.chat = counting
    for _ in range(3):
        run_script("enrich-analyze.py", "--chat", "stuck_chat")
    ch = enrich.load_chats()["stuck_chat"]
    check(ch["status"] == "done" and "7" in ch.get("err", ""), f"после трёх заходов чат закрыт: {ch['status']}, {ch.get('err')}")
    check(not any("Автор0" in c.split("►", 1)[-1].split("\n", 1)[0] for c in calls),
          "«висящих» авторов к модели больше не отправляли")
    check(not tglib.is_frozen_error(ValueError('No user has "Frozen_Soul" as username')),
          "ник с «frozen_» — не заморозка аккаунта")

    print("\n▸ разбор: предфильтр по словам темы и сообщения-триггеры")
    ev_id = 556
    enrich.add_chats([{"ref": "t.me/ev_chat", "chat_id": ev_id, "title": "Соседи ЖК"}])
    enrich.set_chat("ev_chat", status="downloaded")
    lines = [(1, 801, "vasya", "Вася", "Олег, хату брать будешь в этом году?", None),
             (2, 802, "oleg", "Олег", "да", 1),
             (30, 803, "fan", "Болельщик", "кто смотрел матч вчера?", None),
             (31, 804, "fan2", "Фанат", "наши опять проиграли", 30)]
    # между ними — 20 нейтральных сообщений, чтобы окна не слиплись
    lines += [(10 + i, 810, "noise", "Шум", "привет всем", None) for i in range(15)]
    # большой чат: предфильтр включается с PREFILTER_FROM авторов
    lines += [(100 + i, 1000 + i, f"m{i}", f"Молчун{i}", "погода норм", None) for i in range(40)]
    with enrich.raw_path(ev_id).open("w", encoding="utf-8") as f:
        for mid, uid, un, name, text, rep in lines:
            f.write(json.dumps({"id": mid, "date": NOW.isoformat(), "uid": uid, "un": un, "name": name,
                                "text": text, "reply_to": rep}, ensure_ascii=False) + "\n")
    enrich.save_stems(enrich.goal(), ["хат", "квартир", "ипотек", "жк", "новостро"])
    asked = []

    def judge_llm(system, user, info=None, **kw):
        me = user.split("►", 1)[-1].split("\n", 1)[0]
        asked.append(me)
        if "(Олег)" in me:
            return '{"lead": true, "score": 88, "why": "ответил «да» на вопрос про хату", "evidence": ["#1", 2], "facts": {}, "note": "- хочет хату"}'
        return '{"lead": false, "score": 5, "why": "не про покупку"}'
    llm.chat = judge_llm
    out = run_script("enrich-analyze.py", "--chat", "ev_chat")
    check(any("к модели не идут: 42" in o for o in out) and not any("Болельщик" in a or "Фанат" in a for a in asked),
          f"авторы без слов темы в окне к модели не идут, «да» рядом с «хату» — идёт: {[o for o in out if 'модели' in o]}")
    oleg = enrich.load_leads().get("802", {})
    ev = (oleg.get("chats") or [{}])[-1].get("evidence") or []
    check([m["id"] for m in ev] == [1, 2] and ev[0]["text"].startswith("Олег, хату") and ev[1]["mine"],
          f"у лида сохранены сообщения-триггеры с автором и текстом: {ev}")

    print("\n▸ поиск чатов: ключевики")
    llm.chat = lambda *a, **k: 'Вот список: ["ЖК Академ", "ипотека екб", "ЖК Академ", "новостройки екб"]'
    run_script("enrich-find.py", "--keywords", "--topic", "Квартиры в Екатеринбурге")
    kw = enrich.read_json(enrich.KEYWORDS, {})
    check([i["q"] for i in kw.get("items", [])] == ["ЖК Академ", "ипотека екб", "новостройки екб"],
          f"ключевики без дублей: {[i['q'] for i in kw.get('items', [])]}")

    print("\n▸ ключевики порциями: многословная модель, обрезанный ответ")
    rounds = []

    def wordy(system, user, max_tokens=400, timeout=90, tries=5, **kw):
        rounds.append((max_tokens, timeout, tries, "Уже есть" in user))
        n = len(rounds)
        if n == 1:          # обрезан по токенам посреди 61-го слова
            return "Вот: [" + ", ".join(f'"ЖК {i}"' for i in range(60)) + ', "ЖК обре'
        if n == 2:
            return json.dumps([f"ЖК {i}" for i in range(50, 120)], ensure_ascii=False)
        return '["ЖК 1", "дом 1", "дом 2"]'
    llm.chat = wordy
    run_script("enrich-find.py", "--keywords", "--topic", "Квартиры в Екатеринбурге")
    kw = enrich.read_json(enrich.KEYWORDS, {})
    kwr = [r for r in rounds if r[0] == 12000]            # последний вызов — корни слов темы
    check(len(kw.get("items", [])) == 122 and len(kwr) == 3,
          f"из обрезанного ответа взято что успело, раунды без повторов: {len(kw.get('items', []))} за {len(kwr)}")
    check(all(r[1] >= 150 and r[2] <= 2 for r in kwr) and kwr[1][3],
          f"длинный ответ — свой таймаут и мало повторов, второй раунд знает, что уже есть: {rounds}")

    print("\n▸ поиск чатов: запросы как названия чатов, отбор живых чатов, снежный ком")
    ns_f = {"__name__": "find_test"}
    src_f = (REPO / "enrich-find.py").read_text("utf-8").rsplit("\nmain()", 1)[0]
    exec(compile(src_f, "enrich-find.py", "exec"), ns_f)
    gq = ns_f["good_query"]
    check(not gq("ищу квартиру екатеринбург покупка") and not gq("продажа квартир Екб") and not gq("где купить квартиру")
          and gq("ЖК Солнечный") == "ЖК Солнечный" and gq("ипотека Екб") and gq("соседи Уралмаш"),
          "фразы покупателя и продавца — мимо, названия чатов — берём")
    sd = ns_f["seeds"](["Екатеринбург", "Екб"], ["новостройки", "ипотека", "ЖК"])
    check("ипотека Екб" in sd and "Екатеринбург" in sd and "ЖК Екатеринбург" in sd, f"код сам собирает «слово темы + место»: {sd[:6]}")

    class T:
        def __init__(self, title):
            self.title = title
    enrich.write_json(enrich.KEYWORDS, {"topic": "т", "at": "S1", "items": [{"q": "ЖК Академ", "done": True}]})
    snow = ns_f["snowball"]([T("ЖК «Светлый» — соседи"), T("мкр Академический | чат"), T("Флуд Екб")], "S1", False)
    items = [i["q"] for i in enrich.read_json(enrich.KEYWORDS, {})["items"]]
    check("ЖК Светлый" in snow and "мкр Академический" in snow and "ЖК Светлый" in items,
          f"новые ЖК и микрорайоны из названий найденных чатов — в ключевики: {snow}")

    class M:
        def __init__(self, text, sender, days):
            self.message, self.sender_id, self.date = text, sender, NOW - timedelta(days=days)

    class Peek:
        def __init__(self, msgs):
            self.msgs = msgs

        async def get_messages(self, target, limit=None):
            return self.msgs
    live = [M(f"кто брал в ипотеку? {i}", 10 + i % 6, 1 + i) for i in range(20)]
    dead = [M("привет", 10 + i % 6, 60) for i in range(20)]
    ads = [M(f"Продам двушку, +7 912 000-00-{i:02d}", 10 + i % 9, 1) for i in range(20)]
    few = [M("наш канал", 10 + i % 2, 1) for i in range(20)]
    grp = {"_obj": types.Channel(id=1, title="t", photo=types.ChatPhotoEmpty(), date=NOW, megagroup=True,
                                 access_hash=1)}
    verdicts = {k: asyncio.run(ns_f["qualify"](Peek(v), grp))[:2] for k, v in
                (("живой", live), ("мёртвый", dead), ("доска", ads), ("двое", few))}
    check(verdicts["живой"][0] and not verdicts["мёртвый"][0] and not verdicts["доска"][0] and not verdicts["двое"][0],
          f"до вступления: живой разговор — берём, мёртвый, доска объявлений и «пишут двое» — мимо: {verdicts}")

    enrich.write_json(enrich.STATE, {**enrich.read_json(enrich.STATE, {}), "goal": "хочет купить авто"})
    ns_f["reject"]({"chat_id": 31, "title": "ЖК чат"}, ns_f["OFF_TOPIC"])
    ns_f["reject"]({"chat_id": 32, "title": "Доска"}, "доска объявлений: 90% — объявления")
    enrich.write_json(enrich.STATE, {**enrich.read_json(enrich.STATE, {}), "goal": "хочет купить квартиру"})
    now_rej = ns_f["rejected_now"]()
    check("31" not in now_rej and "32" in now_rej,
          f"«не по теме» прошлого запроса не мешает новому, доска объявлений — мимо всегда: {sorted(now_rej)}")
    st0 = enrich.read_json(enrich.STATE, {})
    st0.pop("goal", None)
    enrich.write_json(enrich.STATE, st0)
    check(not NAME_TEST(ns_f, "ЖКХ Екатеринбурга") and NAME_TEST(ns_f, "ЖК «Светлый» соседи"),
          "«ЖКХ» — не «ЖК»: мусорных ключевиков из названий нет")

    print("\n▸ поиск чатов: ключевик и похожие каналы")
    enrich.write_json(enrich.KEYWORDS, {"topic": "Квартиры в Екатеринбурге", "at": "T1",
                                        "items": [{"q": "ЖК Академ", "done": False, "found": 0}]})
    enrich.write_json(enrich.STATE, {"on": False, "finding": True})
    enrich.add_chats([{"ref": "@stale_name", "title": "Был канал", "kind": "channel"}], source="вручную")
    llm.chat = lambda *a, **k: "[0, 1, 2, 3]"           # «модель»: всё по теме
    run_script("enrich-find.py", "--account", "r1", client=Client())
    q = enrich.load_chats()
    check(q.get("akadem_news2", {}).get("kind") == "channel" and q.get("akadem_group", {}).get("kind") == "group",
          "поиск по ключевику: канал и группа в очереди, тип запомнен")
    check(q.get("rec_one", {}).get("level") == 1 and "похожие на @akadem_news2" in q["rec_one"].get("source", ""),
          f"похожий канал в очереди, шаг 1: {q.get('rec_one')}")
    check("rec_nolink" not in q and "rec_req" not in q, "похожие без комментариев и «по заявке» отсеяны")
    check(q["akadem_news2"].get("similar") is True, "у канала похожие уже проверены — второй раз не спросим")
    check(q["stale_name"].get("similar") is True, "ник отдали человеку — канал пропущен, поиск не встал")
    run_script("enrich-find.py", "--account", "r1", client=Client())
    q = enrich.load_chats()
    check(q.get("rec_two", {}).get("level") == 2, "похожие на похожие — шаг 2")
    out = run_script("enrich-find.py", "--account", "r1", client=Client())
    check(not enrich.similar_seeds() and any("искать нечего" in o for o in out),
          "дальше второго шага не идём, поиск заканчивается")

    print("\n▸ профиль лида: «о себе», личный канал, продавцы")

    class FullU:
        def __init__(self, uid):
            seller = uid == 2
            self.full_user = type("FU", (), {
                "about": "Агентство недвижимости, подберу квартиру" if seller else "Инженер, двое детей",
                "birthday": types.Birthday(day=5, month=3), "personal_channel_id": 950 + uid,
                "business_intro": None, "business_location": None})()
            self.users = [u(uid) if uid in USERS else types.User(id=uid, first_name="Гость", access_hash=1)]
            self.chats = [chan(950 + uid, f"pch{uid}", f"Канал {uid}")]

    class ProfClient(Client):
        async def get_messages(self, entity, limit=None, offset_id=0, ids=None):
            if getattr(entity, "id", 0) >= 950:
                posts = ["Продаю двушку, комиссия 0%"] if entity.id == 952 else ["Сходили в ЖК Академ, понравились планировки"]
                return [type("P", (), {"message": t, "date": NOW})() for t in posts]
            return await super().get_messages(entity, limit=limit, offset_id=offset_id, ids=ids)

        async def __call__(self, req):
            if isinstance(req, functions.users.GetFullUserRequest):
                self.calls.append("GetFullUserRequest")
                return FullU(req.id.user_id)
            return await super().__call__(req)

        async def get_input_entity(self, ent):
            if isinstance(ent, int):
                return types.InputPeerUser(ent, ent * 10)    # читатель видел — в кеше сессии
            return await super().get_input_entity(ent)

    def prof_llm(system, user, **kw):
        seller = "Продаю" in user or "Агентство" in user
        return json.dumps({"seller": seller, "facts": {} if seller else {"работа": "инженер", "дети": "двое"},
                           "note": "- инженер, двое детей"}, ensure_ascii=False)
    llm.chat = prof_llm
    pc = ProfClient()
    run_script("enrich-profile.py", "--account", "r1", client=pc)
    L = enrich.load_leads()
    olya, mraz = L["4"], L["2"]
    check(olya.get("profile_at") and olya["facts"].get("работа") == "инженер" and olya["facts"].get("район"),
          f"профиль дописал факты к фактам из чата: {olya.get('facts')}")
    check(olya.get("profile", {}).get("channel", {}).get("posts") == 1 and "### Профиль" in olya["note"],
          "личный канал прочитан, заметка о профиле в карточке")
    check(mraz.get("excluded") and "@mraz" not in enrich.lead_refs(), "продавец по профилю исключён и писать ему не будем")
    check(not enrich.profile_todo(), "профили всех лидов посмотрены")
    check(tglib.can_write({"phone": "@mraz", "by": "lead", "tg": "true"}, "w1") is False,
          "исключённому продавцу не пишет и обычная рассылка по чатам")
    check(tglib.can_write({"phone": "@chmo", "by": "lead", "tg": "true"}, "w1") is True, "остальным лидам — пишет")

    print("\n▸ профиль: отказ модели по одному человеку не стопорит очередь")
    for uid, un in ((61, "risky"), (62, "calm")):
        enrich.add_lead(uid, un, un, {"chat_id": CHAT_ID, "ref": "@akadem_sosedi", "title": "ЖК Академ"},
                        [1], f"ищет ({un})", "- ищет", [], facts={}, score=80)

    def refusing(system, user, info=None, **kw):
        if user == "ок":
            return "ок"
        if "(risky)" in user:
            llm.LAST_ERR = "400: Content Exists Risk"
            if info is not None:
                info["code"] = "400"
            return None
        return prof_llm(system, user)
    llm.chat = refusing
    out = run_script("enrich-profile.py", "--account", "r1", client=ProfClient())
    L = enrich.load_leads()
    check(L["62"].get("profile_at") and not L["61"].get("profile_at") and L["61"].get("profile_tries") == 1,
          f"после отказа по @risky очередь пошла дальше: {out[-4:]}")
    run_script("enrich-profile.py", "--account", "r1", client=ProfClient())
    check(not enrich.profile_todo(), "после второго отказа лид идёт без профиля, автопилот не висит")

    print("\n▸ профиль: лид из закрытого чата другого читателя")
    (TMP / "accounts.json").write_text(json.dumps([acc, {"id": "r2", "title": "читатель 2", "role": "read", "authed": True}]), "utf-8")
    enrich.add_chats([{"ref": "t.me/+Closed9", "chat_id": 909, "title": "Закрытый"}], source="вручную")
    enrich.set_chat("+Closed9", reader="r2")
    key909 = next(k for k, v in enrich.load_chats().items() if v.get("chat_id") == 909)
    enrich.set_chat(key909, reader="r2")
    enrich.add_lead(63, "", "Без ника", {"chat_id": 909, "ref": "t.me/+Closed9", "title": "Закрытый"},
                    [5], "ищет", "- ищет", [], facts={}, score=80)

    class NoCache(ProfClient):
        async def get_input_entity(self, ent):
            if ent == 63:
                raise ValueError("Could not find the input entity")
            return await super().get_input_entity(ent)
    # вторая ссылка-инвайт на тот же чат: id узнаёт вступивший, чат — дубль
    enrich.add_chats(["t.me/+Closed9b"], source="вручную")
    k2 = next(k for k, v in enrich.load_chats().items() if "Closed9b" in v.get("ref", ""))
    enrich.set_chat(k2, status="skipped", reader="r1", chat_id=909)
    check(enrich.chat_readers().get("909") == {"r2"},
          f"дубль по второй ссылке не делает вступившего «знающим» людей чата: {enrich.chat_readers().get('909')}")
    llm.chat = prof_llm
    out = run_script("enrich-profile.py", "--account", "r1", client=NoCache())
    st = json.loads(next(o for o in reversed(out) if o.startswith("⌁STATE"))[6:])
    check(not enrich.load_leads()["63"].get("profile_tries") and any("оставлю ему" in o for o in out)
          and st.get("cooldown") == 600,
          f"чужого лида из закрытого чата не трогаем, попытку не тратим, зря не перезапускаемся: {out[-3:]}")
    run_script("enrich-profile.py", "--account", "r1", "--alive", "r1", client=NoCache())
    check(enrich.load_leads()["63"].get("profile_tries") == 1,
          "его читатель выбыл (панель его не запускает) — пробует любой, попытка считается")
    (TMP / "accounts.json").write_text(json.dumps([acc]), "utf-8")
    enrich.save_profile(63, err="тест")

    print("\n▸ автопилот: одна фраза → цель, тема, ключевики")
    many = ["ЖК Академ", "новостройки екб", "ЖК Академ", "ипотека екб"] + [f"ЖК {i}" for i in range(12)]
    llm.chat = lambda *a, **k: ('Думаю… {"goal": "хочет купить квартиру в Екатеринбурге", "topic": "квартиры Екатеринбург", '
                                '"keywords": ' + json.dumps(many, ensure_ascii=False) + '}')
    out = run_script("enrich-find.py", "--plan", "--query", "хочет квартиру в Екб")
    last = json.loads(next(o for o in reversed(out) if o.startswith("{")))
    kw = enrich.read_json(enrich.KEYWORDS, {})
    check(last.get("goal", "").startswith("хочет купить квартиру") and last.get("n") == 15
          and kw.get("topic") == "квартиры Екатеринбург" and len(kw.get("items", [])) == 15,
          f"план автопилота: {last}")
    calls = []

    def blank_first(system, user, **k):
        calls.append(1)
        return "" if len(calls) == 1 else ('{"goal": "хочет дом", "topic": "дома Екб", "keywords": '
                                           + json.dumps([f"посёлок {i}" for i in range(12)], ensure_ascii=False) + '}')
    llm.chat = blank_first
    out = run_script("enrich-find.py", "--plan", "--query", "хочет дом")
    last = next((o for o in reversed(out) if o.startswith("{")), "")
    check('"ok": true' in last and "хочет дом" in last, f"пустой ответ модели — ещё попытка, план принят: {out[-1:]}")
    llm.chat = lambda *a, **k: ('Формат: {"goal": "...", "topic": "...", "keywords": ["...", "..."]}\n'
                                '{"goal": "хочет авто", "topic": "авто", "keywords": ["тойота", "лада')
    out = run_script("enrich-find.py", "--plan", "--query", "хочет авто")
    check(any(o.startswith("exit модель не разобрала") for o in out) and enrich.read_json(enrich.KEYWORDS, {}).get("topic")
          == "дома Екб", f"шаблон «...» из ответа модели — не план, ключевики не тронуты: {out[-1:]}")

    print("\n▸ llm.chat: «думающая» модель с маленьким лимитом")
    import importlib
    import types as _t
    real_llm = importlib.reload(llm)          # настоящий chat, без подмен выше
    seen_limits = []

    def fake_run(cmd, **kw):
        body = json.loads(cmd[cmd.index("-d") + 1])
        seen_limits.append((body["max_tokens"], cmd[cmd.index("-m") + 1]))
        empty = body["max_tokens"] < 4000
        return _t.SimpleNamespace(stdout=json.dumps({"choices": [{
            "message": {"content": "" if empty else "[0, 2]"},
            "finish_reason": "length" if empty else "stop"}]}))
    old_env = real_llm._ENV
    real_llm._ENV = {"LLM_API_KEY": "test", "LLM_BASE_URL": "https://openrouter.ai/api/v1"}
    old_run = real_llm.subprocess.run
    real_llm.subprocess.run = fake_run
    try:
        got = real_llm.chat("s", "u", max_tokens=400, temperature=0)
    finally:
        real_llm.subprocess.run, real_llm._ENV = old_run, old_env
    check(got == "[0, 2]" and [x[0] for x in seen_limits] == [400, 4000] and seen_limits[1][1] == "180",
          f"пустой ответ из-за лимита — повтор с лимитом побольше: {seen_limits}")

    print("\n▸ ГигаЧат: вход, кеш токена, протухший токен, фильтр тем, кончились токены")
    giga = importlib.reload(llm)
    calls_g = []
    plan_g = {"chat": []}

    def giga_run(cmd, **kw):
        url = next(x for x in cmd if x.startswith("https://"))
        calls_g.append(url.rsplit("/", 1)[-1])
        if "oauth" in url:
            assert any(x.startswith("Authorization: Basic ") for x in cmd)
            return _t.SimpleNamespace(stdout=json.dumps({"access_token": f"tok{len(calls_g)}",
                                                          "expires_at": int((time.time() + 1800) * 1000)}) + "\n200",
                                      returncode=0, stderr="")
        body = json.loads(cmd[cmd.index("-d") + 1])
        assert body["temperature"] > 0
        code, reply = plan_g["chat"].pop(0)
        return _t.SimpleNamespace(stdout=json.dumps(reply) + f"\n{code}", returncode=0, stderr="")
    ok_reply = {"choices": [{"message": {"content": "работает"}, "finish_reason": "stop"}]}
    giga._ENV = {"GIGACHAT_CREDENTIALS": "dGVzdDp0ZXN0"}
    giga.GIGA_TOKEN = TMP / ".gigachat-token.json"
    old_run = giga.subprocess.run
    giga.subprocess.run = giga_run
    try:
        plan_g["chat"] = [("200", ok_reply), ("200", ok_reply)]
        a = giga.chat("s", "u", temperature=0, provider="gigachat")
        b = giga.chat("s", "u", provider="gigachat")
        check(a == b == "работает" and calls_g.count("oauth") == 1,
              f"токен берётся один раз и живёт в кеше: {calls_g}")
        calls_g.clear()
        plan_g["chat"] = [("401", {"message": "Token has expired"}), ("200", ok_reply)]
        check(giga.chat("s", "u", provider="gigachat") == "работает" and calls_g.count("oauth") == 1,
              f"протухший токен — новый и повтор: {calls_g}")
        info = {}
        plan_g["chat"] = [("200", {"choices": [{"message": {"content": "Не люблю менять тему"},
                                                "finish_reason": "blacklist"}]})]
        check(giga.chat("s", "u", provider="gigachat", info=info) is None and info.get("code") == "400",
              f"фильтр тем ГигаЧата — отказ в этом запросе (400): {giga.LAST_ERR}")
        info = {}
        plan_g["chat"] = [("402", {"message": "Payment Required"})]
        check(giga.chat("s", "u", provider="gigachat", info=info) is None and info.get("code") == "402",
              f"кончились токены — 402, разбор поймёт это как простой: {giga.LAST_ERR}")
    finally:
        giga.subprocess.run = old_run
    os.environ["GIGACHAT_CREDENTIALS"] = "x"
    check(enrich.llm_provider() == "gigachat", "ключ ГигаЧата есть — обогащение идёт через него")
    os.environ["ENRICH_LLM"] = "openrouter"
    check(enrich.llm_provider() is None, "ENRICH_LLM=openrouter — общая модель панели")
    del os.environ["GIGACHAT_CREDENTIALS"], os.environ["ENRICH_LLM"]

    print("\n▸ панель пишет очередь через enrich.py")
    f = TMP / "links.txt"
    f.write_text("t.me/new_chat\nt.me/akadem_sosedi\n", "utf-8")
    res = subprocess.run([sys.executable, str(REPO / "enrich.py"), "add", str(f)], capture_output=True,
                         text=True, env={**os.environ})
    check('"added": 1' in res.stdout, f"add через командную строку: {res.stdout.strip()}")

    print(f"\n{'ВСЁ ХОРОШО' if not FAILS else 'ПРОВАЛЕНО: ' + str(len(FAILS))}")
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(1 if FAILS else 0)


main()
