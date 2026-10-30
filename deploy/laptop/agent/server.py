#!/usr/bin/env python3
"""
Пульт агента — чат в браузере с агентом на Claude Agent SDK. Платит ключ
Console (кредиты к тарифу Max оплачивают Agent SDK, но не Claude Code).

    ./ai            запустить пульт в фоне и открыть его в браузере
                    (уже запущен — просто откроет)
    ./ai stop       выключить
    ./ai term       старый режим — в терминале

Слушает только 127.0.0.1, каждый запрос — с одноразовым ключом из адреса
страницы: чужая вкладка браузера к пульту не достучится.

Сервер панели пускает ноутбук только без VPN, а Claude работает только с ним.
Поэтому агент на сервер не ходит: кнопки «Выложить», «Забрать», «Логи» в
пульте запускают ./tg, когда VPN выключен.
"""
import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent                  # ~/tg-panel/.tools/agent
PROJECT = Path(os.environ.get("TG_PROJECT") or HERE.parent.parent).resolve()
HOME = Path.home() / ".tg-agent"
KEY, STATE, RUN, LOG = HOME / "key", HOME / "state.json", HOME / "server.json", HOME / "server.log"
TOKEN = HOME / "token"     # постоянный: перезапуск пульта не выкидывает открытую вкладку
PANEL = HOME / "panel.json"  # вход в панель на сервере — чтобы агент сам гонял «Лиды» в ночную смену
PORT = int(os.environ.get("TG_AGENT_PORT", "8765"))
FAKE = os.environ.get("TG_AGENT_FAKE") == "1"           # для проверки страницы без API
MODELS = [("opus", "Opus 5.5", "$4 / $20"), ("sonnet", "Sonnet 5.5", "$2 / $10"), ("haiku", "Haiku 5.5", "дешевле всех")]
BUDGET = 200.0
ANSI = re.compile(r"\x1b\[[0-9;]*m")
LOCAL_ONLY = re.compile(r"^(tests/|\.claude/|\.tools/|server-data/|CLAUDE\.md$|tg$|ai$|panel$|venv|node_modules/)")
# Что спрашивать даже в режиме «без вопросов»: сервер, система, история git
DANGER = re.compile(r"""
    (^|[;&|(`\s])(ssh|scp|rsync|sudo|su|systemctl|reboot|shutdown|mkfs|dd|crontab)\b
  | \./tg\s+(ship|undo|restart|data|pull|sh|ssh|tools)\b | \./panel\s+post\b
  | \bgit\s+(push|remote|reset\s+--hard|clean|filter-branch|rebase|update-ref|branch\s+-[dD])
  | \brm\s+(-\w+\s+)*(/|~|\$HOME|\.\.)
  | (curl|wget)[^|]*\|\s*(ba|z)?sh
  | \bchmod\s+-R | \bchown\b
  | server-data/ | \.ssh/ | \.tg-agent/
""", re.X)
# Чего не делаем даже на автопилоте — отказ без вопроса, агенту объясняем почему:
# стереть корень или домашнюю папку, отформатировать диск, оборвать рассылку
NEVER = re.compile(r"""
    \brm\s+(-\w+\s+)*(/|~|\$HOME|/home/[^/\s]+)/?(\s|$|[;&|])
  | \bmkfs | \bdd\s+if= | :\(\)\s*\{
  | \./tg\s+(ship|restart)\b[^;&|\n]*--force
""", re.X)
CMDS = {"ship": "Выложить на сервер", "pull": "Забрать код с сервера", "logs": "Журнал панели",
        "data": "Обновить данные", "status": "Что отличается", "undo": "Откатить выкладку"}
STYLE = """Отвечай по-русски, коротко и по делу. Только короткое тире «-», длинное «—» не используй.
Английский термин — сразу с переводом в скобках. Работаешь за деньги хозяина (API): не читай файлы
целиком без нужды (grep, диапазоны строк), не запускай лишних субагентов.
Хозяин смотрит на тебя через пульт в браузере: справа у него кнопки «Выложить», «Забрать код»,
«Журнал панели», «Обновить данные».
Связь с сервером проверяй так: ssh -o ConnectTimeout=8 tg-server true. Нет связи — значит VPN её
режет (обход ./tg bypass не настроен): тогда ./tg ship|pull|logs и ssh не запускай, проси хозяина
нажать кнопку и прислать вывод. Есть связь — журнал и состояние сервера смотри сам (./tg logs 200,
ssh tg-server '…'), а выкладывай (./tg ship) только когда хозяин просит или идёт ночная смена.
Если ты МЕНЯЛ файлы и сам не выложил — последней строкой: «Готово к выкладке: нажми «Выложить»».
Только читал или отвечал на вопрос — этой строки не пиши."""

# Ночная смена: пульт сам ведёт агента по кругу, пока задача не готова, не кончились
# бюджет или время. Агент заканчивает смену одной из этих строк.
DONE_MARK, HUMAN_MARK = "МИССИЯ ВЫПОЛНЕНА", "НУЖЕН ЧЕЛОВЕК"
WAIT_MARK = re.compile(r"ЖДУ\s+(\d{1,3})\s*МИН")       # «подожди N минут» — идёт прогон, тратить нечего
MISSION_FIRST = """НОЧНАЯ СМЕНА. Хозяин спит и до утра не ответит — работай сам, ничего не спрашивай.

Задача: {goal}

Время: до {until} (это {hours}). Бюджет смены: ${budget}. Модель: {model}.

Как работать:
1. Сначала план (TodoWrite) и журнал смены docs/NIGHT.md: что сделал, что проверил, что выложил,
   что осталось и что узнал. Обновляй журнал после каждого шага — беседа длинная, её начало
   сожмётся и забудется, а журнал останется. Потерял нить — перечитай журнал.
2. Цикл: правка → локальная проверка (./tg test, node --check, python3 -m py_compile) → {deploy}
3. Сервер: {server}
{panel}4. Нельзя: --force; писать людям и трогать рассылку, прокси, аккаунты, пароли; править файлы данных
   на сервере руками; запускать Telegram-задачи на сервере в обход панели (тот же аккаунт сразу из
   двух мест — Telegram его выкинет).
5. После каждой выкладки: ./tg logs 80 и ssh tg-server 'systemctl is-active tg-panel'. Панель не
   active или в журнале новые ошибки — сразу ./tg undo, потом разбирайся.
6. Застрял на одном месте после трёх попыток — запиши в журнал и бери следующий пункт.
7. Нужно подождать (идёт прогон, панель что-то делает) — закончи ответ строкой «ЖДУ N МИН»
   (N — до 60): пульт разбудит тебя через N минут. Не жди внутри команд (sleep) — это зря тратит
   время и деньги, а ожидание через пульт бесплатное.
8. Всё сделано и проверено — итог в docs/NIGHT.md и последней строкой: {done}.
   Дальше без человека никак — напиши почему и последней строкой: {human}."""
MISSION_NEXT = """{waited}Продолжай ночную смену. Осталось {left_time} и ${left_money}.
Задача: {goal}
{notes}Сверься с планом и docs/NIGHT.md и сделай следующий шаг. Готово и проверено — итог в
docs/NIGHT.md и последней строкой: {done}."""
MISSION_LAST = """Время ночной смены вышло. Ничего нового не начинай: допиши в docs/NIGHT.md итог —
что сделано, что выложено и проверено, что осталось и с чего начать утром. Последней строкой: {done}."""


def load_json(p, default):
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return default


def save_json(p, data, mode=None):
    HOME.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    if mode:
        os.chmod(tmp, mode)
    tmp.replace(p)


def short(tool, inp):
    """Что делает инструмент — одной строкой; пути — от папки проекта."""
    if tool == "Bash":
        return str(inp.get("command", ""))[:400]
    if tool == "TodoWrite" and isinstance(inp.get("todos"), list):
        t = inp["todos"]
        done = sum(1 for x in t if isinstance(x, dict) and x.get("status") == "completed")
        return f"план: {len(t)} пунктов, сделано {done}"
    for k in ("file_path", "notebook_path", "path", "pattern", "url", "query", "description", "prompt"):
        if inp.get(k):
            v = str(inp[k])
            if k in ("file_path", "notebook_path", "path") and v.startswith(str(PROJECT) + "/"):
                v = v[len(str(PROJECT)) + 1:]
            return v[:300]
    return json.dumps(inp, ensure_ascii=False)[:300]


def trim(v, n=4000):
    if isinstance(v, str):
        return v if len(v) <= n else v[:n] + f"\n… (ещё {len(v) - n} симв.)"
    if isinstance(v, dict):
        return {k: trim(x, n) for k, x in v.items()}
    if isinstance(v, list):
        return [trim(x, n) for x in v[:200]]
    return v


def git(*args):
    r = subprocess.run(["git", "-c", "core.quotePath=false", *args], cwd=PROJECT,
                       capture_output=True, text=True)
    return r.stdout


class Hub:
    """Одна беседа на пульт; все открытые вкладки видят одно и то же."""

    def __init__(self):
        self.socks = set()
        self.log = []                 # события беседы — для новой вкладки
        self.cmd_log = []             # вывод последней команды ./tg
        self.st = load_json(STATE, {})
        self.client = None
        self.busy = False
        self.task = None
        self.pending = {}             # id вопроса -> Future
        self.allowed = set()
        self.session_cost = 0.0
        self.streaming = False
        self.context = None
        self.todos = []
        self.cmd = None
        self.server = {"ok": None, "at": 0, "err": ""}
        self.last_text = ""           # последний ответ агента (не субагентов)
        self.last_error = ""
        self.turn_failed = False
        # SDK в каждом итоге присылает стоимость всей беседы с начала (и после
        # продолжения в новом процессе — тоже с накопленной суммы). Цена ответа —
        # разница с прошлым итогом; складывать сами итоги — считать одно по многу раз
        self.cost_last = 0.0
        self.inhibit = None           # systemd-inhibit: ноутбук не засыпает, пока идёт смена
        self.wake = None              # разбудить агента раньше срока («ЖДУ N МИН»)
        m = self.st.get("mission")
        self.mission = m if isinstance(m, dict) else None

    # ── рассылка в браузер ──
    async def emit(self, ev, keep=True):
        if keep:
            self.log.append(ev)
            if len(self.log) > 4000:
                del self.log[:1000]
        for ws in list(self.socks):
            try:
                await ws.send_json(ev)
            except Exception:
                self.socks.discard(ws)

    def month(self, add=0.0):
        m = time.strftime("%Y-%m")
        sp = self.st.setdefault("spent", {})
        sp[m] = round(sp.get(m, 0.0) + add, 4)
        return sp[m]

    def state(self):
        return {"type": "state", "model": self.st.get("model", "opus"), "models": MODELS,
                "autopilot": bool(self.st.get("autopilot")), "busy": self.busy, "key": KEY.exists() or FAKE,
                "session": self.st.get("session"), "project": str(PROJECT),
                "cost": {"session": round(self.session_cost, 4), "month": self.month(), "budget": BUDGET},
                "context": self.context, "todos": self.todos, "server": self.server,
                "cmd": self.cmd, "fake": FAKE, "mission": self.mission,
                "panel": PANEL.exists()}

    async def push_state(self):
        await self.emit(self.state(), keep=False)

    # ── агент ──
    def options(self, resume=None):
        from claude_agent_sdk import ClaudeAgentOptions
        rules = load_json(PROJECT / ".claude" / "settings.json", {}).get("permissions") or {}
        return ClaudeAgentOptions(
            cwd=str(PROJECT),
            system_prompt={"type": "preset", "preset": "claude_code", "append": STYLE},
            setting_sources=["project"],
            permission_mode="acceptEdits",
            can_use_tool=self.can_use,
            allowed_tools=list(rules.get("allow") or []),
            disallowed_tools=list(rules.get("deny") or []),
            model=self.st.get("model", "opus"),
            resume=resume,
            include_partial_messages=True,
            stderr=lambda line: None if "not been trusted" in line or "hasTrustDialogAccepted" in line
            else print(line.rstrip(), file=sys.stderr),
        )

    async def start(self, resume=None):
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
        self.client = None
        if not KEY.exists() and not FAKE:
            return
        os.environ["ANTHROPIC_API_KEY"] = "fake" if FAKE else KEY.read_text("utf-8").strip()
        for k in ("ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"):
            os.environ.pop(k, None)
        seen = self.st.get("cost_seen") or {}
        # продолжаем беседу, о которой итога не знаем (например, первую после обновления
        # пульта): её прошлую сумму не угадать — первый ответ не считаем, чем завысить в разы
        self.cost_last = (float(seen[resume]) if resume in seen else None) if resume else 0.0
        if FAKE:
            self.client = FakeClient(self)
        else:
            from claude_agent_sdk import ClaudeSDKClient
            self.client = ClaudeSDKClient(self.options(resume))
        await self.client.connect()

    async def new(self, resume=None):
        await self.stop_turn()
        self.log, self.session_cost, self.context, self.todos = [], 0.0, None, []
        self.allowed.clear()
        await self.emit({"type": "reset"}, keep=False)
        if resume:
            await self.replay(resume)
        self.st["session"] = resume
        save_json(STATE, self.st)
        await self.start(resume)
        await self.push_state()

    async def replay(self, sid):
        """Прошлая беседа из журнала SDK — чтобы было видно, о чём говорили."""
        try:
            from claude_agent_sdk import get_session_messages
            msgs = get_session_messages(sid, directory=str(PROJECT))
        except Exception as e:
            await self.emit({"type": "info", "text": f"историю не прочитал: {e}"})
            return
        for m in msgs:
            msg = m.message if isinstance(m.message, dict) else {}
            content = msg.get("content")
            if m.parent_tool_use_id:
                continue
            if m.type == "user":
                if isinstance(content, str):
                    await self.emit({"type": "user", "text": content, "images": []})
                elif isinstance(content, list):
                    texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                    if texts:
                        await self.emit({"type": "user", "text": "\n".join(texts), "images": []})
            elif m.type == "assistant" and isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text" and b.get("text"):
                        await self.emit({"type": "assistant", "text": b["text"]})
                    elif b.get("type") == "tool_use":
                        await self.emit({"type": "tool", "id": b.get("id"), "name": b.get("name"),
                                         "summary": short(b.get("name"), b.get("input") or {}),
                                         "input": trim(b.get("input") or {}, 1500), "sub": False})
        await self.emit({"type": "info", "text": "это прошлая беседа — можно продолжать"})

    async def prompt(self, text, images):
        if self.busy:
            if self.running_mission():
                # посреди смены — указание уйдёт агенту следующим шагом
                self.mission.setdefault("notes", []).append(text)
                self.save_mission()
                await self.emit({"type": "info", "text": f"передам агенту следующим шагом: {text[:200]}"})
                return
            await self.emit({"type": "error", "text": "агент ещё работает — дождись или нажми «Стоп»"}, keep=False)
            return
        if not self.client:
            await self.start(self.st.get("session"))
            if not self.client:
                await self.emit({"type": "error", "text": "нет API-ключа — введи его вверху"}, keep=False)
                return
        await self.emit({"type": "user", "text": text, "images": [i["url"] for i in images]})
        self.task = asyncio.ensure_future(self.turn(text, images))

    async def turn(self, text, images):
        self.busy = True
        self.turn_failed, self.last_text, self.last_error = False, "", ""
        await self.push_state()
        try:
            if images:
                async def one():
                    blocks = [{"type": "image", "source": {"type": "base64", "media_type": i["type"], "data": i["data"]}}
                              for i in images]
                    blocks.append({"type": "text", "text": text or "посмотри на картинку"})
                    yield {"type": "user", "message": {"role": "user", "content": blocks}, "parent_tool_use_id": None}
                await self.client.query(one())
            else:
                await self.client.query(text)
            async for m in self.client.receive_response():
                await self.on_msg(m)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self.emit({"type": "error", "text": f"{type(e).__name__}: {str(e)[:500]}"})
            self.turn_failed, self.last_error = True, str(e)
            self.client = None             # следующий запрос поднимет агента заново (с этой же беседой)
        finally:
            self.busy = False
            self.streaming = False
            for f in self.pending.values():
                if not f.done():
                    f.set_result(("deny", "беседу остановили"))
            self.pending.clear()
            await self.push_state()

    async def on_msg(self, m):
        from claude_agent_sdk import (AssistantMessage, ResultMessage, StreamEvent, SystemMessage, TextBlock,
                                      ThinkingBlock, ToolResultBlock, ToolUseBlock, UserMessage)
        if isinstance(m, StreamEvent):
            ev = m.event or {}
            if m.parent_tool_use_id is None and ev.get("type") == "content_block_delta":
                d = ev.get("delta") or {}
                if d.get("type") == "text_delta":
                    self.streaming = True
                    await self.emit({"type": "delta", "text": d.get("text", "")}, keep=False)
                elif d.get("type") == "thinking_delta":
                    await self.emit({"type": "thinking"}, keep=False)
        elif isinstance(m, AssistantMessage):
            sub = m.parent_tool_use_id is not None
            for b in m.content:
                if isinstance(b, TextBlock) and not sub and b.text.strip():
                    self.last_text = b.text
                    await self.emit({"type": "assistant", "text": b.text})
                elif isinstance(b, ToolUseBlock):
                    inp = b.input or {}
                    await self.emit({"type": "tool", "id": b.id, "name": b.name, "summary": short(b.name, inp),
                                     "input": trim(inp, 3000), "sub": sub})
                    if self.running_mission() and b.name == "Bash" and re.search(r"\./tg\s+ship\b", str(inp.get("command", ""))):
                        self.mission["ships"] = self.mission.get("ships", 0) + 1
                    if b.name == "TodoWrite" and isinstance(inp.get("todos"), list):
                        self.todos = inp["todos"]
                        await self.push_state()
                elif isinstance(b, ThinkingBlock):
                    pass
            self.streaming = False
        elif isinstance(m, UserMessage) and isinstance(m.content, list):
            for b in m.content:
                if isinstance(b, ToolResultBlock):
                    c = b.content
                    if isinstance(c, list):
                        c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
                    await self.emit({"type": "tool_result", "id": b.tool_use_id, "error": bool(b.is_error),
                                     "text": trim(str(c or ""), 6000)})
        elif isinstance(m, ResultMessage):
            total = float(m.total_cost_usd or 0.0)
            if self.cost_last is None:
                cost = 0.0
            else:
                cost = total - self.cost_last if total >= self.cost_last else total
            self.cost_last = total
            if m.session_id:
                seen = self.st.setdefault("cost_seen", {})
                seen[m.session_id] = total
                for k in list(seen)[:-40]:
                    seen.pop(k, None)
            self.session_cost += cost
            month = self.month(cost)
            if m.is_error:
                self.turn_failed = True
                self.last_error = str(m.result or m.subtype or "")
            if self.running_mission():
                self.mission["spent"] = round(self.mission.get("spent", 0) + cost, 4)
                self.st["mission"] = self.mission
            if m.session_id:
                self.st["session"] = m.session_id
            save_json(STATE, self.st)
            try:
                u = await self.client.get_context_usage()
                self.context = round(float(u.get("percentage", 0)), 1)
            except Exception:
                pass
            await self.emit({"type": "result", "cost": round(cost, 4), "session": round(self.session_cost, 4),
                             "month": month, "error": m.is_error, "subtype": m.subtype,
                             "seconds": round((m.duration_ms or 0) / 1000)})
        elif isinstance(m, SystemMessage) and m.subtype == "compact_boundary":
            await self.emit({"type": "info", "text": "беседа длинная — агент сжал её начало"})

    # ── ночная смена ──
    def running_mission(self):
        return bool(self.mission and self.mission.get("status") == "running")

    def save_mission(self):
        self.st["mission"] = self.mission
        save_json(STATE, self.st)

    def inhibit_on(self):
        """Не дать ноутбуку уснуть, пока идёт смена. Сторож сам уходит, если пульт упал."""
        if self.inhibit or not shutil.which("systemd-inhibit"):
            return None
        watch = f"while kill -0 {os.getpid()} 2>/dev/null; do sleep 20; done"
        for what in ("idle:sleep:handle-lid-switch", "idle:sleep"):
            p = subprocess.Popen(["systemd-inhibit", f"--what={what}", "--who=Агент tg-panel", "--why=ночная смена",
                                  "--mode=block", "sh", "-c", watch],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.7)
            if p.poll() is None:
                self.inhibit = p
                return what
        return None

    def inhibit_off(self):
        if self.inhibit:
            try:
                self.inhibit.terminate()
            except Exception:
                pass
            self.inhibit = None

    def mission_text(self, kind):
        m = self.mission
        left = max(0, m["until"] - time.time())
        until = time.strftime("%H:%M", time.localtime(m["until"]))
        hours = f"{int(left // 3600)} ч {int(left % 3600 // 60)} мин"
        if kind == "last":
            return MISSION_LAST.format(done=DONE_MARK)
        if kind == "next":
            notes = m.pop("notes", None) or []
            self.save_mission()
            note = "".join(f"Указание хозяина: {n}\n" for n in notes)
            waited = m.pop("waited", 0)
            return MISSION_NEXT.format(waited=f"Прошло {waited} мин — проверь, что изменилось. " if waited else "",
                                       left_time=hours, left_money=round(m["budget"] - m.get("spent", 0), 2),
                                       goal=m["goal"], notes=note, done=DONE_MARK)
        deploy = ("выкладка (./tg ship — уезжают только изменённые файлы) → проверка на сервере → вывод → следующая\n"
                  "   правка. Выкладывай маленькими шагами и проверяй каждый."
                  if m.get("deploy") else
                  "следующая правка. На сервер НЕ выкладывай — хозяин выложит сам утром; сервер можно только смотреть.")
        server = ("связь есть (ssh tg-server). Журнал — ./tg logs 200, состояние — ssh tg-server '…' (код и данные\n"
                  "   основного профиля — /opt/tg-panel, Python-задачи руками — только через runuser -u tgpanel)."
                  if self.server.get("ok") else
                  "связи сейчас нет (VPN). Работай локально; раз в час проверяй ssh -o ConnectTimeout=8 tg-server true —\n"
                  "   появится связь, выкладывай накопленное.")
        panel = ""
        if PANEL.exists():
            panel = ("   Панель на сервере — через ./panel (сам входит): ./panel get /api/enrich — состояние «Лидов»,\n"
                     "   ./panel log — журнал панели, ./panel leads — лиды последнего захода, ./panel readers —\n"
                     "   читатели, ./panel post /api/enrich/auto '{json}' — запуск и остановка автопилота\n"
                     "   (подробно: grep -n \"what === 'auto'\" -A20 admin.mjs).\n")
        return MISSION_FIRST.format(goal=m["goal"], until=until, hours=hours, budget=m["budget"],
                                    model=self.st.get("model", "opus"), deploy=deploy, server=server, panel=panel,
                                    done=DONE_MARK, human=HUMAN_MARK)

    async def mission_start(self, d):
        if self.running_mission():
            return await self.emit({"type": "error", "text": "смена уже идёт"}, keep=False)
        goal = str(d.get("goal") or "").strip()
        if not goal:
            return await self.emit({"type": "error", "text": "напиши задачу на смену"}, keep=False)
        now = time.time()
        try:
            hh, mm = [int(x) for x in str(d.get("until") or "08:00").split(":")[:2]]
            t = time.localtime(now)
            until = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, hh, mm, 0, 0, 0, -1))
            if until <= now + 300:
                until += 86400
        except Exception:
            until = now + 8 * 3600
        budget = max(1.0, min(200.0, float(d.get("budget") or 20)))
        if d.get("user") and d.get("pass"):
            save_json(PANEL, {"user": str(d["user"]), "pass": str(d["pass"])}, mode=0o600)
        self.st["autopilot"] = True               # ночью спрашивать некого
        self.mission = {"goal": goal, "until": until, "budget": budget, "deploy": bool(d.get("deploy", True)),
                        "status": "running", "started": now, "spent": 0.0, "turns": 0, "ships": 0, "reason": ""}
        self.save_mission()
        await self.check_server()
        what = self.inhibit_on()
        await self.emit({"type": "mission_start", "until": until, "budget": budget,
                         "sleep": "ноутбук не уснёт, пока идёт смена" + (" (и с закрытой крышкой)" if what and "lid" in what else "")
                         if what else "не смог запретить сон — отключи засыпание в настройках питания"})
        await self.push_state()
        asyncio.ensure_future(self.mission_loop(first=True))

    async def mission_loop(self, first=False):
        m, errors = self.mission, 0
        while self.mission is m and m.get("status") == "running":
            if self.busy:
                await asyncio.sleep(2)
                continue
            if m.get("spent", 0) >= m["budget"]:
                return await self.mission_end("кончился бюджет смены")
            last = time.time() >= m["until"]
            text = self.mission_text("first" if first else "last" if last else "next")
            first = False
            if not self.client:
                await self.start(self.st.get("session"))
                if not self.client:
                    return await self.mission_end("нет API-ключа")
            m["turns"] = m.get("turns", 0) + 1
            self.save_mission()
            await self.emit({"type": "user", "text": text, "images": [], "auto": True})
            await self.turn(text, [])
            if self.mission is not m or m.get("status") != "running":
                return
            self.save_mission()
            if self.turn_failed:
                errors += 1
                low = self.last_error.lower()
                if "credit balance" in low or "billing" in low:
                    return await self.mission_end("на ключе кончились деньги")
                if errors >= 12:
                    return await self.mission_end("агент не отвечает: 12 сбоев подряд")
                wait = min(600, 30 * 2 ** min(errors - 1, 5))
                await self.emit({"type": "info", "text": f"сбой ({self.last_error[:120] or 'нет ответа'}) — повторю через {max(1, wait // 60)} мин"})
                await asyncio.sleep(wait)
                continue
            errors = 0
            tail = self.last_text[-400:]
            w = WAIT_MARK.search(tail)
            if w and not last and DONE_MARK not in tail and HUMAN_MARK not in tail:
                mins = max(1, min(60, int(w.group(1))))
                wake = min(time.time() + mins * 60, m["until"])
                m["wait_until"] = wake
                self.save_mission()
                await self.push_state()
                await self.emit({"type": "info", "text": "агент ждёт — проверит в "
                                 + time.strftime("%H:%M", time.localtime(wake))})
                self.wake = asyncio.Event()
                try:
                    await asyncio.wait_for(self.wake.wait(), max(1, wake - time.time()))
                except asyncio.TimeoutError:
                    pass
                if self.mission is not m or m.get("status") != "running":
                    return
                m["waited"] = max(1, round((time.time() - (wake - mins * 60)) / 60))
                m.pop("wait_until", None)
                self.save_mission()
                await self.push_state()
                continue
            if DONE_MARK in tail:
                return await self.mission_end("агент закончил задачу" if not last else "время смены вышло", ok=True)
            if HUMAN_MARK in tail:
                return await self.mission_end("агенту нужен человек — смотри его последнее сообщение")
            if last:
                return await self.mission_end("время смены вышло", ok=True)
            if m["turns"] >= 400:
                return await self.mission_end("слишком много шагов за смену")
            await asyncio.sleep(3)

    async def mission_end(self, reason, ok=False):
        m = self.mission
        if not m:
            return
        m.update(status="done" if ok else "stopped", reason=reason, ended=time.time())
        self.save_mission()
        self.inhibit_off()
        await self.emit({"type": "mission_end", "ok": ok, "reason": reason, "turns": m.get("turns", 0),
                         "spent": m.get("spent", 0), "ships": m.get("ships", 0),
                         "hours": round((m["ended"] - m["started"]) / 3600, 1),
                         "journal": (PROJECT / "docs" / "NIGHT.md").exists()})
        await self.push_state()

    async def mission_stop(self):
        if not self.running_mission():
            return
        m = self.mission
        m["status"] = "stopping"
        if self.wake:
            self.wake.set()
        await self.stop_turn()
        self.mission = m
        await self.mission_end("остановил хозяин")

    def dangerous(self, tool, inp):
        if tool == "Bash":
            return bool(DANGER.search(str(inp.get("command", ""))))
        p = inp.get("file_path") or inp.get("notebook_path") or inp.get("path")
        if p and tool in ("Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob"):
            try:
                rp = Path(p if os.path.isabs(p) else PROJECT / p).resolve()
            except Exception:
                return True
            inside = rp == PROJECT or PROJECT in rp.parents
            if tool in ("Read", "Grep", "Glob"):
                return not inside and not str(rp).startswith("/tmp")
            return not inside or (PROJECT / "server-data") in rp.parents
        return False

    async def can_use(self, tool, inp, ctx):
        from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny
        risky = self.dangerous(tool, inp)
        summary = short(tool, inp)
        if tool == "Bash" and NEVER.search(str(inp.get("command", ""))):
            await self.emit({"type": "info", "text": f"не дал выполнить (опасно даже на автопилоте): {summary}"})
            return PermissionResultDeny(message="Это запрещено в этом проекте даже на автопилоте "
                                                "(стирание корня или домашней папки, форматирование, выкладка с --force). "
                                                "Сделай по-другому или спроси хозяина в ответе.", interrupt=False)
        if self.st.get("autopilot"):
            if risky:                 # не спрашиваем, но и не молчим: видно в ленте
                await self.emit({"type": "info", "text": f"автопилот разрешил: {tool} · {summary[:160]}"})
            return PermissionResultAllow(updated_input=inp)
        if not risky or (tool, summary) in self.allowed:
            return PermissionResultAllow(updated_input=inp)
        pid = secrets.token_hex(4)
        fut = asyncio.get_running_loop().create_future()
        self.pending[pid] = fut
        await self.emit({"type": "ask", "id": pid, "tool": tool, "summary": summary, "risky": risky,
                         "input": trim(inp, 2000)})
        decision, why = await fut
        self.pending.pop(pid, None)
        await self.emit({"type": "asked", "id": pid, "decision": decision})
        if decision == "deny":
            return PermissionResultDeny(message=why or "хозяин запретил это действие", interrupt=False)
        if decision == "always":
            self.allowed.add((tool, summary))
        return PermissionResultAllow(updated_input=inp)

    async def stop_turn(self):
        if self.busy and self.client:
            for f in self.pending.values():
                if not f.done():
                    f.set_result(("deny", "остановлено"))
            try:
                await self.client.interrupt()
            except Exception:
                pass
            if self.task:
                try:
                    await asyncio.wait_for(asyncio.shield(self.task), 15)
                except Exception:
                    self.task.cancel()

    # ── команды ./tg ──
    async def check_server(self):
        p = await asyncio.create_subprocess_exec(
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "tg-server", "true",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, err = await p.communicate()
        self.server = {"ok": p.returncode == 0, "at": time.time(),
                       "err": "" if p.returncode == 0 else err.decode("utf-8", "replace").strip()[-200:]}
        await self.push_state()
        return self.server["ok"]

    async def run_cmd(self, name, args):
        if self.cmd:
            return
        self.cmd, self.cmd_log = name, []
        await self.push_state()
        await self.emit({"type": "cmd_start", "name": name, "title": CMDS.get(name, name)}, keep=False)
        code = -1
        try:
            p = await asyncio.create_subprocess_exec(
                str(PROJECT / "tg"), name, *args, cwd=PROJECT, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            async for raw in p.stdout:
                line = ANSI.sub("", raw.decode("utf-8", "replace").rstrip("\n"))
                self.cmd_log.append(line)
                await self.emit({"type": "cmd_line", "line": line}, keep=False)
            code = await p.wait()
        except Exception as e:
            await self.emit({"type": "cmd_line", "line": f"не запустилось: {e}"}, keep=False)
        self.cmd = None
        self.server = {"ok": code == 0 or self.server.get("ok"), "at": time.time(), "err": ""} if code == 0 else self.server
        await self.emit({"type": "cmd_done", "name": name, "code": code}, keep=False)
        await self.push_state()


class FakeClient:
    """Агент-понарошку (TG_AGENT_FAKE=1): проверить страницу, не тратя деньги."""

    def __init__(self, hub):
        self.hub, self.stop, self.total = hub, False, hub.cost_last or 0.0

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def interrupt(self):
        self.stop = True

    async def set_model(self, m):
        pass

    async def get_context_usage(self):
        return {"percentage": 12.5}

    async def query(self, prompt):
        self.stop = False
        self.prompt = prompt if isinstance(prompt, str) else ""
        if not isinstance(prompt, str):
            async for _ in prompt:
                pass

    async def receive_response(self):
        from claude_agent_sdk import (AssistantMessage, ResultMessage, StreamEvent, TextBlock, ToolResultBlock,
                                      ToolUseBlock, UserMessage)
        for w in "Смотрю, что в **enrich-analyze.py** и как идёт разбор…".split(" "):
            if self.stop:
                break
            await asyncio.sleep(0.05)
            yield StreamEvent(uuid="u", session_id="s", event={"type": "content_block_delta",
                                                               "delta": {"type": "text_delta", "text": w + " "}})
        yield AssistantMessage(content=[TextBlock("Смотрю, что в **enrich-analyze.py** и как идёт разбор…"),
                                        ToolUseBlock("t1", "Bash", {"command": "grep -n 'def judge' enrich-analyze.py"})],
                               model="fake")
        await self.hub.can_use("Bash", {"command": "grep -n 'def judge' enrich-analyze.py"}, None)
        yield UserMessage(content=[ToolResultBlock("t1", "278:def judge(system, msgs, me):", False)])
        yield AssistantMessage(content=[ToolUseBlock("t2", "TodoWrite", {"todos": [
            {"content": "Очередь к ГигаЧату", "status": "completed", "activeForm": "Делаю очередь"},
            {"content": "Рейтинг авторов", "status": "in_progress", "activeForm": "Делаю рейтинг авторов"},
            {"content": "Общие корни", "status": "pending", "activeForm": "Убираю общие корни"}]})], model="fake")
        r = await self.hub.can_use("Bash", {"command": "ssh tg-server uptime"}, None)
        ok = type(r).__name__ == "PermissionResultAllow"
        yield AssistantMessage(content=[ToolUseBlock("t3", "Bash", {"command": "ssh tg-server uptime"})], model="fake")
        yield UserMessage(content=[ToolResultBlock("t3", "up 3 days" if ok else "запрещено хозяином", not ok)])
        yield AssistantMessage(content=[ToolUseBlock("t4", "Edit", {"file_path": str(PROJECT / "enrich-analyze.py"),
                                                                    "old_string": "    return Fail(\"bad\")",
                                                                    "new_string": "    return fail or Fail(\"bad\")"})],
                               model="fake")
        yield UserMessage(content=[ToolResultBlock("t4", "ok", False)])
        if not self.stop:
            yield AssistantMessage(content=[TextBlock(
                "Готово. Что поменял:\n\n| Файл | Что |\n|---|---|\n| `enrich-analyze.py` | сбой куска не отменяет лид |\n\n"
                "```python\nif fail and not yes:\n    return fail\n```\n\nГотово к выкладке: выключи VPN и нажми «Выложить»."
                + ("\n\n" + DONE_MARK if "Продолжай ночную смену" in getattr(self, "prompt", "")
                   and (self.hub.mission or {}).get("turns", 0) >= 3 else
                   "\n\nПрогон запущен.\nЖДУ 1 МИН" if getattr(self, "prompt", "").startswith("НОЧНАЯ") else ""))],
                model="fake")
        yield ResultMessage(subtype="success", duration_ms=4200, duration_api_ms=4000, is_error=False, num_turns=3,
                            session_id="fake-session", total_cost_usd=self._add(0.0123))

    def _add(self, x):
        self.total = round(self.total + x, 6)
        return self.total


# ─────────────────────────────── веб ───────────────────────────────

def make_app(hub, token):
    from aiohttp import WSMsgType, web

    @web.middleware
    async def guard(req, handler):
        if req.path.startswith("/api/") or req.path == "/ws":
            if req.headers.get("X-Token") != token and req.query.get("t") != token:
                return web.json_response({"error": "нет доступа"}, status=403)
            origin = req.headers.get("Origin")
            if origin and origin not in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
                return web.json_response({"error": "чужая страница"}, status=403)
        return await handler(req)

    async def index(req):
        return web.FileResponse(HERE / "index.html", headers={"Cache-Control": "no-store"})

    async def ws_handler(req):
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=40 * 1024 * 1024)
        await ws.prepare(req)
        hub.socks.add(ws)
        await ws.send_json({"type": "reset"})
        for ev in hub.log:
            await ws.send_json(ev)
        await ws.send_json(hub.state())
        if hub.cmd_log:
            await ws.send_json({"type": "cmd_replay", "lines": hub.cmd_log[-400:], "running": hub.cmd})
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    d = json.loads(msg.data)
                except ValueError:
                    continue
                t = d.get("type")
                if t == "prompt":
                    imgs = [i for i in (d.get("images") or []) if i.get("data") and i.get("type", "").startswith("image/")]
                    for i in imgs:
                        i["url"] = f"data:{i['type']};base64,{i['data']}"
                    await hub.prompt(str(d.get("text") or "").strip(), imgs[:6])
                elif t == "stop":
                    await hub.stop_turn()
                elif t == "answer":
                    f = hub.pending.get(d.get("id"))
                    if f and not f.done():
                        f.set_result((d.get("decision", "deny"), str(d.get("why") or "")))
                elif t == "model":
                    name = d.get("model")
                    if name in [m[0] for m in MODELS]:
                        hub.st["model"] = name
                        save_json(STATE, hub.st)
                        if hub.client:
                            try:
                                await hub.client.set_model(name)
                            except Exception:
                                hub.client = None
                        await hub.push_state()
                elif t == "spent":
                    # поправить счётчик месяца по Console (platform.claude.com/usage)
                    try:
                        v = max(0.0, float(d.get("value")))
                    except (TypeError, ValueError):
                        continue
                    hub.st.setdefault("spent", {})[time.strftime("%Y-%m")] = round(v, 2)
                    save_json(STATE, hub.st)
                    await hub.push_state()
                elif t == "autopilot":
                    hub.st["autopilot"] = bool(d.get("value"))
                    save_json(STATE, hub.st)
                    if hub.st["autopilot"]:       # то, что уже ждёт ответа, — тоже разрешаем
                        for f in list(hub.pending.values()):
                            if not f.done():
                                f.set_result(("allow", ""))
                    await hub.push_state()
                elif t == "mission_start":
                    await hub.mission_start(d)
                elif t == "mission_stop":
                    await hub.mission_stop()
                elif t == "wake":
                    if hub.wake:
                        hub.wake.set()
                elif t == "new":
                    if hub.running_mission():
                        await hub.emit({"type": "error", "text": "идёт ночная смена — сначала останови её"}, keep=False)
                        continue
                    await hub.new(None)
                elif t == "resume":
                    if hub.running_mission():
                        await hub.emit({"type": "error", "text": "идёт ночная смена — сначала останови её"}, keep=False)
                        continue
                    await hub.new(str(d.get("id")))
        finally:
            hub.socks.discard(ws)
        return ws

    async def api_key(req):
        d = await req.json()
        k = str(d.get("key") or "").strip()
        if not k.startswith("sk-ant-"):
            return web.json_response({"error": "это не ключ Anthropic (sk-ant-…)"}, status=400)
        HOME.mkdir(parents=True, exist_ok=True)
        KEY.write_text(k, "utf-8")
        os.chmod(KEY, 0o600)
        await hub.start(hub.st.get("session"))
        await hub.push_state()
        return web.json_response({"ok": True})

    async def api_changes(req):
        files = []
        for ln in git("diff", "--numstat", "server", "--", ".").splitlines():
            parts = ln.split("\t", 2)
            if len(parts) == 3 and not LOCAL_ONLY.match(parts[2]):
                files.append({"path": parts[2], "add": parts[0], "del": parts[1]})
        for p in git("ls-files", "--others", "--exclude-standard").splitlines():
            if p and not LOCAL_ONLY.match(p):
                files.append({"path": p, "add": "new", "del": "0"})
        return web.json_response({"files": files})

    async def api_diff(req):
        f = req.query.get("f", "")
        if not f or ".." in f.split("/"):
            return web.json_response({"error": "нет файла"}, status=400)
        out = git("diff", "server", "--", f)
        if not out and (PROJECT / f).is_file():
            out = "".join("+" + ln for ln in (PROJECT / f).read_text("utf-8", "replace").splitlines(True))
        return web.json_response({"diff": out[:400000]})

    async def api_file(req):
        f = req.query.get("f", "")
        p = (PROJECT / f).resolve()
        if not f or PROJECT not in p.parents or not p.is_file():
            return web.json_response({"error": "нет файла"}, status=404)
        return web.json_response({"text": p.read_text("utf-8", "replace")[:300000]})

    async def api_sessions(req):
        try:
            from claude_agent_sdk import list_sessions
            out = [{"id": s.session_id, "title": (s.custom_title or s.summary or s.first_prompt or "")[:90],
                    "at": s.last_modified} for s in list_sessions(str(PROJECT), limit=20)]
        except Exception as e:
            return web.json_response({"sessions": [], "error": str(e)[:200]})
        return web.json_response({"sessions": out})

    async def api_server(req):
        ok = await hub.check_server()
        return web.json_response({"ok": ok, "err": hub.server["err"]})

    async def api_cmd(req):
        d = await req.json()
        name = d.get("cmd")
        if name not in CMDS:
            return web.json_response({"error": "нет такой команды"}, status=400)
        if hub.cmd:
            return web.json_response({"error": f"уже идёт: {CMDS[hub.cmd]}"}, status=409)
        args = {"logs": ["200"]}.get(name, [])
        if d.get("big") and name == "data":
            args = ["--big"]
        asyncio.ensure_future(hub.run_cmd(name, args))
        return web.json_response({"ok": True})

    async def api_quit(req):
        asyncio.get_running_loop().call_later(0.3, lambda: os.kill(os.getpid(), signal.SIGTERM))
        return web.json_response({"ok": True})

    app = web.Application(middlewares=[guard], client_max_size=40 * 1024 * 1024)
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_post("/api/key", api_key)
    app.router.add_get("/api/changes", api_changes)
    app.router.add_get("/api/diff", api_diff)
    app.router.add_get("/api/sessions", api_sessions)
    app.router.add_get("/api/file", api_file)
    app.router.add_post("/api/server", api_server)
    app.router.add_post("/api/cmd", api_cmd)
    app.router.add_post("/api/quit", api_quit)
    return app


def running():
    """Пульт уже запущен? -> его адрес с ключом или None."""
    r = load_json(RUN, {})
    try:
        pid = int(r.get("pid") or 0)
        if pid <= 0:                  # kill(0) бьёт по всей группе процессов — только живой номер
            return None
        os.kill(pid, 0)
    except Exception:
        return None
    import urllib.request
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{r['port']}/", timeout=2).read(100)
    except Exception:
        return None
    return f"http://127.0.0.1:{r['port']}/?t={r['token']}"


def serve():
    from aiohttp import web
    token = ""
    try:
        token = TOKEN.read_text("utf-8").strip()
    except OSError:
        pass
    if len(token) < 16:
        token = secrets.token_urlsafe(18)
        HOME.mkdir(parents=True, exist_ok=True)
        TOKEN.write_text(token, "utf-8")
        os.chmod(TOKEN, 0o600)
    hub = Hub()
    app = make_app(hub, token)

    async def on_start(_):
        save_json(RUN, {"pid": os.getpid(), "port": PORT, "token": token}, mode=0o600)
        await hub.start(hub.st.get("session"))
        if hub.st.get("session") and not FAKE:
            await hub.replay(hub.st["session"])
        if hub.running_mission():             # пульт перезапускали посреди смены — продолжаем
            await hub.check_server()
            hub.inhibit_on()
            await hub.emit({"type": "info", "text": "пульт перезапустился — продолжаю ночную смену"})
            asyncio.ensure_future(hub.mission_loop())

    async def on_stop(_):
        hub.inhibit_off()
        if hub.client:
            try:
                await hub.client.disconnect()
            except Exception:
                pass
        if load_json(RUN, {}).get("pid") == os.getpid():
            RUN.unlink(missing_ok=True)

    app.on_startup.append(on_start)
    async def on_shutdown(_):
        # открытая вкладка держала бы старый пульт (и порт) ещё минуту — закрываем сразу
        for ws in list(hub.socks):
            try:
                await ws.close(code=1001, message=b"restart")
            except Exception:
                pass

    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_stop)
    print(f"пульт: http://127.0.0.1:{PORT}/?t={token}", flush=True)
    web.run_app(app, host="127.0.0.1", port=PORT, print=None, handle_signals=True, shutdown_timeout=3)


def our_servers():
    """Все запущенные пульты этого пользователя — и те, о ком server.json уже забыл."""
    pids = set()
    pid = int(load_json(RUN, {}).get("pid") or 0)
    if pid > 0:
        pids.add(pid)
    proc = Path("/proc")
    if proc.is_dir():
        for d in proc.iterdir():
            if not d.name.isdigit() or int(d.name) == os.getpid():
                continue
            try:
                if d.stat().st_uid != os.getuid():
                    continue
                cmd = (d / "cmdline").read_bytes().split(b"\0")
            except OSError:
                continue
            if b"--serve" in cmd and any(c.endswith(b"agent/server.py") for c in cmd):
                pids.add(int(d.name))
    return [p for p in pids if alive(p)]


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop_all():
    """Выключить пульт и дождаться, пока он отпустит порт."""
    pids = our_servers()
    for p in pids:
        try:
            os.kill(p, signal.SIGTERM)
        except OSError:
            pass
    for _ in range(40):
        if not any(alive(p) for p in pids):
            break
        time.sleep(0.25)
    for p in pids:
        if alive(p):
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass
    RUN.unlink(missing_ok=True)
    return len(pids)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--serve":
        return serve()
    if arg == "stop":
        print("пульт выключен" if stop_all() else "пульт и так не запущен")
        return
    url = running()
    if not url:
        stop_all()                    # недовыключенный старый пульт держал бы порт
        HOME.mkdir(parents=True, exist_ok=True)
        with open(LOG, "ab") as log:
            subprocess.Popen([sys.executable, __file__, "--serve"], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True, cwd=PROJECT)
        for _ in range(60):
            time.sleep(0.25)
            url = running()
            if url:
                break
        if not url:
            try:
                tail = "\n".join(LOG.read_text("utf-8", "replace").splitlines()[-12:])
            except OSError:
                tail = ""
            sys.exit(f"пульт не запустился. Конец журнала ({LOG}):\n{tail}")
    print(f"пульт: {url}\nвыключить: ./ai stop")
    if os.environ.get("TG_AGENT_NO_BROWSER") != "1":
        webbrowser.open(url)


if __name__ == "__main__":
    main()
