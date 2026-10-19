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


class Full:
    def __init__(self):
        self.full_chat = type("F", (), {"linked_chat_id": CHAT_ID})()
        self.chats = [CHANNEL, GROUP]


class Client:
    """Ровно то, что зовут enrich-read и find_member/via_message."""

    def __init__(self):
        self.calls = []

    async def get_entity(self, ref):
        if ref in ("akadem_sosedi", CHAT_ID):
            return GROUP
        if ref == "akadem_news":
            return CHANNEL
        raise ValueError(f"Could not find the input entity for {ref}")

    async def get_input_entity(self, ent):
        return types.InputPeerChannel(ent.id, ent.access_hash)

    async def get_messages(self, entity, limit=None, offset_id=0, ids=None):
        if ids is not None:
            return [next((m for m in MSGS if m.id == i), None) for i in ids]
        older = [m for m in reversed(MSGS) if not offset_id or m.id < offset_id]
        self.calls.append(("history", offset_id))
        return older[:limit]

    async def __call__(self, req):
        self.calls.append(type(req).__name__)
        if isinstance(req, functions.channels.GetFullChannelRequest):
            return Full()
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


def fake_llm(system, user, max_tokens=400, temperature=0.8, tries=5, model=None, info=None):
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
    return ("Думаю {вслух}: смотрю на ► …\n" +
            json.dumps({"lead": lead, "why": why, "note": note}, ensure_ascii=False))


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
    check("JoinChannelRequest" in c.calls and "LeaveChannelRequest" in c.calls, "вступил и вышел")
    raw = [json.loads(x) for x in enrich.raw_path(CHAT_ID).read_text("utf-8").splitlines()]
    check(all(m["uid"] != 6 for m in raw), "бот отброшен")
    check(all("всем привет" not in m["text"] for m in raw), "сообщения старше 90 дней не читаются")
    check(ch["msgs"] == len(raw) == len(SCRIPT) - 2, f"сообщений {ch['msgs']} (ожидалось {len(SCRIPT) - 2})")
    check(enrich.joins_today("r1") == 1, "вступление посчитано")
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

    print("\n▸ разбор: модель ответила без вердикта")

    def flaky(system, user, info=None, **kw):
        olya = "(Оля)" in user.split("►", 1)[-1].split("\n", 1)[0]
        return "не знаю, что сказать" if olya else fake_llm(system, user)
    llm.chat = flaky
    run_script("enrich-analyze.py")
    ch = enrich.load_chats()["akadem_sosedi"]
    check(ch["status"] == "downloaded" and ch.get("tries") == 1, f"чат ждёт повтора: {ch['status']}, tries {ch.get('tries')}")
    check(enrich.raw_path(CHAT_ID).exists(), "сырые сообщения не удалены, пока не разобраны все")
    check("4" not in enrich.load_leads(), "Оля ещё не разобрана")

    print("\n▸ обрезанный ответ модели")
    ns_a = {"__name__": "analyze_test"}
    src_a = (REPO / "enrich-analyze.py").read_text("utf-8").rsplit("\nmain()", 1)[0]
    exec(compile(src_a, "enrich-analyze.py", "exec"), ns_a)
    v = ns_a["verdict"]('думаю {так}\n{"lead": true, "why": "берёт двушку", "note": "- **Район:** Академ\\n- бюджет до 7')
    check(v and v["lead"] and "Академ" in v["note"], f"лид из обрезанного JSON: {v}")
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
    src = (REPO / "draft-messages.py").read_text("utf-8").replace("asyncio.run(main())", "")
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

    print("\n▸ поиск чатов: ключевики")
    llm.chat = lambda *a, **k: 'Вот список: ["ЖК Академ", "ипотека екб", "ЖК Академ", "новостройки екб"]'
    run_script("enrich-find.py", "--keywords", "--topic", "Квартиры в Екатеринбурге")
    kw = enrich.read_json(enrich.KEYWORDS, {})
    check([i["q"] for i in kw.get("items", [])] == ["ЖК Академ", "ипотека екб", "новостройки екб"],
          f"ключевики без дублей: {[i['q'] for i in kw.get('items', [])]}")

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
