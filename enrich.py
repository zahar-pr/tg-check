"""
Обогащение: ищем в чатах людей, которые хотят квартиру, и копим о них заметки.

Общие файлы и замки для трёх задач:
  enrich-find.py     — ключевики по теме (LLM) и поиск чатов по ним;
  enrich-read.py     — читатель: вступил, выкачал 90 дней, вышел;
  enrich-analyze.py  — разбор по авторам моделью, лиды в enrich/leads.json.

Файлы (папка профиля):
  enrich/chats.json      очередь чатов и галочки: ключ -> запись (см. add_chats)
  enrich/raw/<id>.jsonl  сырые сообщения чата, живут до конца разбора
  enrich/progress/<id>.json  какие авторы уже разобраны (перезапуск не начинает заново)
  enrich/keywords.json   тема и ключевики для поиска чатов
  enrich/state.json      включён ли сбор и цель разбора (пишет панель)
  enrich/joins.json      кто когда вступал — дневной предел вступлений
  enrich/leads.json      лиды: uid -> карточка с заметкой (не путать со старым
                         leads.json в корне — его вёл убранный поиск горячих лидов)

Чат в очереди проходит статусы:
  new -> reading -> downloaded -> analyzing -> done
  и в сторону: skipped (нечего читать, дубль) и error (не открылся).
Один чат берёт ровно один читатель: выбор идёт под замком файла, поэтому два
аккаунта никогда не читают и не разбирают одно и то же.
"""
import json
import os
from datetime import datetime, timedelta, timezone

import llm
import tglib
from chatlib import chat_ref, locked

ROOT = tglib.DIR / "enrich"
CHATS = ROOT / "chats.json"
RAW = ROOT / "raw"
PROGRESS = ROOT / "progress"
KEYWORDS = ROOT / "keywords.json"
STATE = ROOT / "state.json"
JOINS = ROOT / "joins.json"
LEADS = ROOT / "leads.json"
STEMS = ROOT / "stems.json"       # корни слов темы для предфильтра разбора (их пишет Python)


def llm_provider():
    """
    Чем обогащение спрашивает модель: Сбер ГигаЧат, если в .env задан его ключ
    (GIGACHAT_CREDENTIALS). ENRICH_LLM=openrouter — вернуть общую модель панели.
    """
    if (llm._cfg("ENRICH_LLM", "") or "").lower() in ("openrouter", "default", "llm"):
        return None
    return "gigachat" if llm.gigachat_ready() else None


def ask_llm(system, user, **kw):
    """llm.chat моделью обогащения."""
    return llm.chat(system, user, provider=llm_provider(), **kw)


def save_stems(goal, stems):
    """Корни слов темы для цели — какие окна вообще показывать модели."""
    clean = sorted({" ".join(str(s).lower().split())[:30] for s in stems if str(s).strip()} - {""})
    ROOT.mkdir(parents=True, exist_ok=True)
    write_json(STEMS, {"goal": goal, "stems": clean, "at": now_iso()})
    return clean


def stems():
    """Корни для текущей цели или [] (тогда разбор без предфильтра или сам их спросит)."""
    d = read_json(STEMS, {})
    return (d.get("stems") or []) if d.get("goal") == goal() else []


STEMS_PROMPT = """Ищем в переписке Telegram-чатов людей, которые {goal}.
Перед разбором отсеиваем куски переписки, где тема даже не упоминается.
Дай 30–60 КОРНЕЙ слов (начала слов, 3–8 букв, в нижнем регистре), которыми
люди говорят об этом в чатах — и прямо, и разговорно, и сокращениями. Для
квартиры, например: «квартир», «хат», «однушк», «двушк», «ипотек», «жк»,
«новостро», «вторичк», «застройщ», «жиль». Город и общие слова («купить»,
«хочу», «нужно») не нужны — только слова самой темы.
Ответь ТОЛЬКО JSON-массивом строк."""


def make_stems(for_goal):
    """
    Корни слов темы у модели обогащения — для предфильтра разбора: к модели
    идут только авторы, в окне которых тема хоть как-то упомянута. Это и есть
    главная экономия токенов: в большом чате о теме говорит малая часть людей.
    Не вышло — [] (разбор пойдёт без предфильтра).
    """
    import re
    out = ask_llm("Отвечай строго в формате, который просят.", STEMS_PROMPT.format(goal=for_goal),
                  max_tokens=1500, temperature=0.3, tries=2, timeout=120) or ""
    starts = [m.end() for m in re.finditer(r"\[\s*(?=\")", out)]
    words = re.findall(r'"([^"\\]{2,30})"', out[starts[-1]:]) if starts else []
    words = [w for w in words if w.strip(" .…") and len(w.strip()) >= 2]
    return save_stems(for_goal, words) if len(words) >= 5 else []

DAYS = 90                    # столько истории читаем
STALE_READING = 3 * 3600     # читатель пропал дольше — чат возвращается в очередь
SIMILAR_LEVELS = 2           # «похожие на похожие»: столько шагов от найденного поиском
GOAL_DEFAULT = ("хочет купить квартиру или другое жильё (новостройку, вторичку, "
                "дом), в том числе в ипотеку")


def now_iso():
    return tglib.now_iso()


def _parse(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def read_json(path, default):
    try:
        data = json.loads(path.read_text("utf-8"))
        return data if isinstance(data, type(default)) else default
    except Exception:
        return default


def write_json(path, data):
    """Атомарно: панель читает эти файлы в любой момент."""
    path.parent.mkdir(parents=True, exist_ok=True)
    # своё имя временного файла у каждого процесса: читатель, разбор и панель
    # пишут одни и те же файлы, общий .tmp они делили бы между собой
    tmp = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", "utf-8")
    tmp.replace(path)


def goal():
    """Что ищем — цель разбора; её задаёт панель, по умолчанию — покупка жилья."""
    return str(read_json(STATE, {}).get("goal") or "").strip() or GOAL_DEFAULT


# ------------------------------------------------------------------ чаты

def ref_key(ref):
    """Одинаковый ключ для одной ссылки в разной записи: t.me/x, @x, x."""
    try:
        r, invite = chat_ref(ref)
    except SystemExit:
        return ""
    return f"+{invite}" if invite else str(r).lower()


def load_chats():
    return read_json(CHATS, {})


def _update(fn):
    """Прочитать-поправить-записать очередь под замком; fn правит словарь на месте."""
    ROOT.mkdir(parents=True, exist_ok=True)
    with locked(CHATS):
        data = load_chats()
        out = fn(data)
        write_json(CHATS, data)
        return out


def add_chats(items, source=""):
    """
    Чаты в очередь. items — строки-ссылки или словари {ref, chat_id, title, n}.
    Дубль отсекаем и по ссылке, и по chat_id: одна группа под двумя ссылками
    второй раз в очередь не встанет. Возвращает, сколько добавлено.
    """
    def fn(data):
        refs = {ref_key(v.get("ref")) for v in data.values()}
        ids = {str(v.get("chat_id")) for v in data.values() if v.get("chat_id")}
        added = 0
        for it in items:
            it = {"ref": it} if isinstance(it, str) else dict(it)
            ref = str(it.get("ref") or "").strip()
            k = ref_key(ref)
            cid = str(it.get("chat_id") or "")
            if not k or k in refs or (cid and cid in ids):
                continue
            refs.add(k)
            if cid:
                ids.add(cid)
            data[k] = {"ref": ref, "chat_id": it.get("chat_id") or "",
                       "title": tglib.cell(it.get("title") or ""), "n": it.get("n") or "",
                       "status": "new", "source": source, "added": now_iso(),
                       # kind — канал или группа (у канала Telegram знает похожие),
                       # level — сколько шагов «похожих» от найденного поиском
                       **({"kind": it["kind"]} if it.get("kind") else {}),
                       **({"level": int(it["level"])} if it.get("level") else {})}
            added += 1
        return added
    return _update(fn)


def pick_chat(acc_id):
    """
    Следующий чат этому читателю. Под замком: чат, отданный одному, другой уже
    не увидит. Чат, у которого читатель пропал (упал процесс, ушёл сервер),
    через STALE_READING возвращается в очередь — дочитает любой.
    """
    def fn(data):
        now = datetime.now(timezone.utc)
        for v in data.values():
            if v.get("status") == "reading":
                at = _parse(v.get("at"))
                # свой «читается» — от прошлого захода этого же аккаунта: панель не
                # запускает аккаунт дважды, значит тот заход умер (упал, убит)
                if v.get("reader") == acc_id or not at or (now - at).total_seconds() > STALE_READING:
                    v["status"] = "new"
        # свой недочитанный — первым (файл уже начат, продолжим с места); чат, куда
        # вступил другой читатель, — в конец: пусть дочитает (и выйдет из него) он
        new = [(k, v) for k, v in data.items() if v.get("status") == "new"]
        mine = [k for k, v in new if v.get("reader") == acc_id or v.get("joined_by") == acc_id]
        free = ([k for k, v in new if not v.get("joined_by")]
                + [k for k, v in new if v.get("joined_by") and v.get("joined_by") != acc_id])
        key = (mine or free or [None])[0]
        if key is None:
            return None, None
        # pid — чей процесс читает: панель вернёт чат в очередь, только если он мёртв
        # read_by — все, кто читал (заход оборвался — дочитывает другой): людей
        # из чата знает сессия каждого из них
        read_by = [r for r in data[key].get("read_by") or [] if r != acc_id] + [acc_id]
        data[key].update(status="reading", reader=acc_id, read_by=read_by, pid=os.getpid(), at=now_iso())
        return key, dict(data[key])
    return _update(fn)


def similar_seeds():
    """
    Каналы, похожие на которые ещё не спрашивали у Telegram: найденные поиском,
    добавленные руками (тип узнаёт читатель) и сами «похожие» — до SIMILAR_LEVELS.
    """
    return [(k, v) for k, v in load_chats().items()
            if v.get("kind") == "channel" and not v.get("similar") and v.get("status") != "error"
            and int(v.get("level") or 0) < SIMILAR_LEVELS and v.get("ref")]


def set_chat(key, **fields):
    def fn(data):
        if key in data:
            data[key].update(fields, at=now_iso())
    _update(fn)


def duplicate_of(key, chat_id):
    """Тот же chat_id уже есть под другим ключом — значит этот чат уже в работе."""
    for k, v in load_chats().items():
        if k != key and str(v.get("chat_id")) == str(chat_id) and v.get("status") != "skipped":
            return k
    return ""


def raw_path(chat_id):
    return RAW / f"{chat_id}.jsonl"


def progress_path(chat_id):
    return PROGRESS / f"{chat_id}.json"


# ------------------------------------------------------------- вступления

def joins_today(acc_id):
    day = datetime.now(timezone.utc).date()
    return sum(1 for at in read_json(JOINS, {}).get(acc_id, [])
               if (_parse(at) or datetime.min.replace(tzinfo=timezone.utc)).date() == day)


def note_join(acc_id):
    with locked(JOINS):
        data = read_json(JOINS, {})
        week = datetime.now(timezone.utc) - timedelta(days=7)
        keep = [a for a in data.get(acc_id, []) if (_parse(a) or week) > week]
        data[acc_id] = keep + [now_iso()]
        write_json(JOINS, data)


# ------------------------------------------------------------------ лиды

def load_leads():
    return read_json(LEADS, {})


def add_lead(uid, username, name, chat, msg_ids, why, note, quotes, facts=None, score=None, evidence=None):
    """
    Лид в leads.json. Один человек — одна карточка, сколько бы чатов его ни
    показали: заметка по новому чату дописывается, ссылки на сообщения копятся.
    Заодно кладём его в очередь рассылки «по чатам» — писать ему будет
    обычная рассылка (by=lead: писать может любой аккаунт, см. tglib.can_write).
    evidence — сообщения, по которым модель решила, что это лид (триггер).
    """
    ROOT.mkdir(parents=True, exist_ok=True)
    with locked(LEADS):
        data = load_leads()
        k = str(uid)
        lead = data.get(k) or {"uid": uid, "found_at": now_iso(), "chats": [], "note": ""}
        for f, d in (("uid", uid), ("chats", []), ("note", "")):
            lead.setdefault(f, d)
        # В очереди рассылки человек лежит под ОДНИМ ключом. Ник мог появиться,
        # смениться или пропасть между чатами — второй ключ (@ник рядом с id:)
        # дал бы ему второе письмо, а то и от двух писателей сразу
        queued = lead.get("key")
        if not queued:
            have = {r.get("phone", "") for r in tglib.read_csv(tglib.CHAT_RESULTS)}
            queued = next((a for a in (tglib.member_key(lead.get("username"), uid), f"id:{uid}",
                                       tglib.member_key(username, uid)) if a and a in have), "")
        new = not queued
        lead["key"] = queued or tglib.member_key(username, uid)
        lead.update(username=username or lead.get("username", ""), name=name or lead.get("name", ""),
                    updated_at=now_iso())
        title = chat.get("title") or chat.get("ref") or ""
        lead["chats"] = [c for c in lead["chats"] if str(c.get("chat_id")) != str(chat.get("chat_id"))]
        lead["chats"].append({"chat_id": chat.get("chat_id"), "ref": chat.get("ref", ""), "title": title,
                              "msg_ids": list(msg_ids)[-20:], "why": why, "quotes": quotes[:5],
                              "evidence": list(evidence or [])[:10], "score": score, "at": now_iso()})
        block = f"### {title}\n{note.strip()}"
        if block not in lead["note"]:
            lead["note"] = (lead["note"].rstrip() + "\n\n" + block).strip()
        # факты по полям — для личного письма: свежий чат уточняет старые значения
        lead["facts"] = {**(lead.get("facts") or {}), **(facts or {})}
        if score is not None:
            lead["score"] = max(int(lead.get("score") or 0), int(score))
        data[k] = lead
        write_json(LEADS, data)
    if new:
        tglib.add_recipients([{"username": username, "user_id": uid, "name": name}], by="lead")


def _keys(lead):
    """Все ключи, под которыми лид может лежать в очереди рассылки."""
    return {k for k in {lead.get("key"), tglib.member_key(lead.get("username"), lead.get("uid")),
                        f"id:{lead.get('uid')}"} if k and k != "id:None"}


def lead_refs():
    """Ключ получателя -> лид: по нему писатель найдёт человека без @username."""
    out = {}
    for lead in load_leads().values():
        if lead.get("excluded"):
            continue                # профиль показал риелтора/продавца — писать не будем
        for k in _keys(lead):
            out[k] = lead
    return out


def excluded_keys():
    """Ключи исключённых лидов: в очереди рассылки они уже лежат, писать им нельзя."""
    return {k for lead in load_leads().values() if lead.get("excluded") for k in _keys(lead)}


PROFILE_TRIES = 2           # столько раз профиль не дался — больше не пробуем


def chat_readers():
    """chat_id -> читатели, которые этот чат читали. Дубль по второй ссылке
    (skipped) не в счёт: его читатель только вступил, людей не видел."""
    out = {}
    for v in load_chats().values():
        if v.get("chat_id") and v.get("status") != "skipped":
            who = set(v.get("read_by") or []) | ({v["reader"]} if v.get("reader") else set())
            out.setdefault(str(v["chat_id"]), set()).update(who)
    return out


def profile_todo():
    """Лиды, чей профиль (описание, личный канал) ещё не смотрели."""
    return [v for v in load_leads().values()
            if not v.get("profile_at") and not v.get("excluded")
            and int(v.get("profile_tries") or 0) < PROFILE_TRIES]


def save_profile(uid, profile=None, facts=None, note="", excluded="", err=""):
    """
    Итог шага «профиль» в карточку лида. err — не вышло (попытка считается);
    excluded — по профилю видно, что это продавец/агент: из лидов его убираем.
    """
    with locked(LEADS):
        data = load_leads()
        lead = data.get(str(uid))
        if not lead:
            return
        if err:
            lead["profile_tries"] = int(lead.get("profile_tries") or 0) + 1
            lead["profile_err"] = err[:200]
        else:
            lead["profile_at"] = now_iso()
            lead["profile"] = profile or {}
            lead["facts"] = {**(lead.get("facts") or {}), **(facts or {})}
            if note.strip() and "### Профиль" not in lead.get("note", ""):
                lead["note"] = (lead.get("note", "").rstrip() + "\n\n### Профиль\n" + note.strip()).strip()
            if excluded:
                lead["excluded"] = excluded[:200]
        write_json(LEADS, data)


def skip_new(why):
    """
    Новый запрос автопилота: чаты прошлого, до которых не дошли, — в «пропущен»
    (кнопка «перечитать» вернёт), а у прошлых каналов похожие больше не ищем.
    """
    def fn(data):
        n = 0
        for v in data.values():
            if v.get("status") == "new":
                v.update(status="skipped", err=why, at=now_iso())
                n += 1
            if v.get("kind") == "channel" and not v.get("similar"):
                v["similar"] = True
        return n
    return _update(fn)


def retry(keys):
    """Чаты с ошибкой или пропущенные — снова в очередь (кнопка «перечитать»)."""
    def fn(data):
        n = 0
        for k in keys:
            if k in data and data[k].get("status") in ("error", "skipped"):
                data[k].update(status="new", err="", reader="")
                n += 1
        return n
    return _update(fn)


def remove(keys):
    """Убрать чаты из очереди (те, что ещё не в работе)."""
    def fn(data):
        n = 0
        for k in keys:
            if k in data and data[k].get("status") in ("new", "error", "skipped"):
                # недочитанное сырьё убранного чата — личные сообщения людей, хранить
                # незачем. Но у дубля тот же chat_id, что у живого чата: его файл не трогаем
                cid = data[k].get("chat_id")
                del data[k]
                if cid and not any(str(v.get("chat_id")) == str(cid) for v in data.values()):
                    raw_path(cid).unlink(missing_ok=True)
                    progress_path(cid).unlink(missing_ok=True)
                n += 1
        return n
    return _update(fn)


def _alive(pid):
    """Жив ли процесс читателя (этой же машины)."""
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return False
    if os.name == "nt":
        # на Windows os.kill(pid, 0) — это Ctrl+C всей консоли панели, не проверка
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return k.GetLastError() == 5               # ERROR_ACCESS_DENIED — процесс есть
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259          # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def release(pairs):
    """
    «Читается», а процесса читателя нет (упал, убит, сервер перезапускали) —
    обратно в очередь. pairs — [(ключ чата, читатель)] от панели; решает не она,
    а pid в записи: панель могла как раз перезапустить этого же читателя, и он
    уже снова взял свой чат — живой процесс не трогаем.
    """
    def fn(data):
        n = 0
        for k, reader in pairs:
            v = data.get(k)
            if (v and v.get("status") == "reading" and v.get("reader") == reader
                    and not _alive(v.get("pid"))):
                v["status"] = "new"
                n += 1
        return n
    return _update(fn)


if __name__ == "__main__":
    # Панель пишет в очередь только через эти команды: замок на файл — здесь,
    # и задачи-читатели не потеряют свою правку из-за записи панели.
    #   python enrich.py add <файл со ссылками>
    #   python enrich.py retry <ключ> [ключ…]
    #   python enrich.py remove <ключ> [ключ…]
    #   python enrich.py release <ключ> <читатель> [ключ читатель…]
    #   python enrich.py skip-new <причина>
    import sys
    cmd, rest = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    if cmd == "add" and rest:
        lines = open(rest[0], encoding="utf-8").read().splitlines()
        refs = [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("#")]
        print(json.dumps({"ok": True, "added": add_chats(refs, source="вручную"), "given": len(refs)}))
    elif cmd == "retry":
        print(json.dumps({"ok": True, "n": retry(rest)}))
    elif cmd == "remove":
        print(json.dumps({"ok": True, "n": remove(rest)}))
    elif cmd == "release":
        print(json.dumps({"ok": True, "n": release(list(zip(rest[::2], rest[1::2])))}))
    elif cmd == "skip-new":
        print(json.dumps({"ok": True, "n": skip_new(" ".join(rest) or "прошлый запрос")}))
    else:
        print(json.dumps({"ok": False, "reason": "команды: add <файл> | retry <ключи> | remove <ключи>"}))
