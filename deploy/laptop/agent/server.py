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
PORT = int(os.environ.get("TG_AGENT_PORT", "8765"))
FAKE = os.environ.get("TG_AGENT_FAKE") == "1"           # для проверки страницы без API
MODELS = [("opus", "Opus 5.5", "$4 / $20"), ("sonnet", "Sonnet 5.5", "$2 / $10"), ("haiku", "Haiku 5.5", "дешевле всех")]
BUDGET = 200.0
ANSI = re.compile(r"\x1b\[[0-9;]*m")
LOCAL_ONLY = re.compile(r"^(tests/|\.claude/|\.tools/|server-data/|CLAUDE\.md$|tg$|ai$|venv|node_modules/)")
# Что спрашивать даже в режиме «без вопросов»: сервер, система, история git
DANGER = re.compile(r"""
    (^|[;&|(`\s])(ssh|scp|rsync|sudo|su|systemctl|reboot|shutdown|mkfs|dd|crontab)\b
  | \./tg\s+(ship|undo|restart|data|pull|sh|ssh|tools)\b
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
«Журнал панели», «Обновить данные». Сам ./tg ship|pull|logs|data и ssh не запускай — с VPN у тебя
нет связи с сервером. Если ты МЕНЯЛ файлы проекта — проверь правку локально и последней строкой
напиши: «Готово к выкладке: выключи VPN и нажми «Выложить»». Если только читал или отвечал на
вопрос — этой строки не пиши. Нужен журнал или состояние сервера — попроси нажать «Журнал панели»
и прислать, что там."""


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
                "cmd": self.cmd, "fake": FAKE}

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
                    await self.emit({"type": "assistant", "text": b.text})
                elif isinstance(b, ToolUseBlock):
                    inp = b.input or {}
                    await self.emit({"type": "tool", "id": b.id, "name": b.name, "summary": short(b.name, inp),
                                     "input": trim(inp, 3000), "sub": sub})
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
            cost = m.total_cost_usd or 0.0
            self.session_cost += cost
            month = self.month(cost)
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
        self.hub, self.stop = hub, False

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
                "```python\nif fail and not yes:\n    return fail\n```\n\nГотово к выкладке: выключи VPN и нажми «Выложить».")],
                model="fake")
        yield ResultMessage(subtype="success", duration_ms=4200, duration_api_ms=4000, is_error=False, num_turns=3,
                            session_id="fake-session", total_cost_usd=0.0123)


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
                elif t == "autopilot":
                    hub.st["autopilot"] = bool(d.get("value"))
                    save_json(STATE, hub.st)
                    if hub.st["autopilot"]:       # то, что уже ждёт ответа, — тоже разрешаем
                        for f in list(hub.pending.values()):
                            if not f.done():
                                f.set_result(("allow", ""))
                    await hub.push_state()
                elif t == "new":
                    await hub.new(None)
                elif t == "resume":
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

    async def on_stop(_):
        if hub.client:
            try:
                await hub.client.disconnect()
            except Exception:
                pass
        if load_json(RUN, {}).get("pid") == os.getpid():
            RUN.unlink(missing_ok=True)

    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    print(f"пульт: http://127.0.0.1:{PORT}/?t={token}", flush=True)
    web.run_app(app, host="127.0.0.1", port=PORT, print=None, handle_signals=True)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--serve":
        return serve()
    if arg == "stop":
        pid = int(load_json(RUN, {}).get("pid") or 0)
        try:
            if pid <= 0:
                raise ProcessLookupError
            os.kill(pid, signal.SIGTERM)
            print("пульт выключен")
        except Exception:
            print("пульт и так не запущен")
        return
    url = running()
    if not url:
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
            sys.exit(f"пульт не запустился — подробности: {LOG}")
    print(f"пульт: {url}\nвыключить: ./ai stop")
    if os.environ.get("TG_AGENT_NO_BROWSER") != "1":
        webbrowser.open(url)


if __name__ == "__main__":
    main()
