#!/usr/bin/env python3
"""
./ai — агент для работы над панелью: тот же движок, что у Claude Code
(Claude Agent SDK), но платит API-ключ Console, а не подписка. Кредиты,
которые идут к тарифу Max, Claude Code не оплачивают, а Agent SDK — оплачивают
(platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).

    ./ai              новый разговор
    ./ai -c           продолжить прошлый
    ./ai "задача"     сразу с задачей

В разговоре:
    /cost             сколько потрачено
    /model opus|sonnet   сменить модель (sonnet вдвое дешевле)
    /new              начать с чистого листа
    /exit или Ctrl+D  выход
    Ctrl+C            остановить агента посреди ответа
    \"\"\"            многострочный текст: начни строкой \"\"\" и закончи ею же

Ключ — в ~/.tg-agent/key (спросит при первом запуске), правила работы с
проектом — в CLAUDE.md и .claude/settings.json этой папки.
"""
import asyncio
import getpass
import json
import os
import signal
import sys
import time
from pathlib import Path

HOME = Path.home() / ".tg-agent"
KEY = HOME / "key"
STATE = HOME / "state.json"
PROJECT = Path(__file__).resolve().parent.parent if Path(__file__).resolve().parent.name == ".tools" \
    else Path.cwd()

DIM, RED, BOLD, OFF = "\033[2m", "\033[31m", "\033[1m", "\033[0m"

# Как говорить с хозяином — поверх правил проекта из CLAUDE.md
STYLE = """Отвечай по-русски, коротко и по делу. Только короткое тире «-», длинное «—» не используй.
Английский термин — сразу с переводом в скобках. Работаешь за деньги хозяина (API): не читай файлы
целиком без нужды (grep, диапазоны строк), не запускай лишних субагентов."""


def load_state():
    try:
        return json.loads(STATE.read_text("utf-8"))
    except Exception:
        return {}


def save_state(st):
    HOME.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(st, ensure_ascii=False, indent=1), "utf-8")


def api_key():
    try:
        k = KEY.read_text("utf-8").strip()
        if k:
            return k
    except FileNotFoundError:
        pass
    print("Нужен API-ключ из Console (platform.claude.com → API keys), начинается с sk-ant-.")
    print("Он сохранится только на этом компьютере: ~/.tg-agent/key")
    k = getpass.getpass("Ключ (ввод не виден): ").strip()
    if not k.startswith("sk-ant-"):
        sys.exit("это не похоже на ключ Anthropic (sk-ant-…)")
    HOME.mkdir(parents=True, exist_ok=True)
    KEY.write_text(k, "utf-8")
    os.chmod(KEY, 0o600)
    return k


def project_rules():
    """Разрешения из .claude/settings.json. Claude Code берёт их оттуда, только если
    папке «доверились» в его диалоге, — агенту передаём их напрямую."""
    try:
        p = json.loads((PROJECT / ".claude" / "settings.json").read_text("utf-8")).get("permissions") or {}
        return list(p.get("allow") or []), list(p.get("deny") or [])
    except Exception:
        return [], []


def cli_stderr(line):
    if "not been trusted" in line or "hasTrustDialogAccepted" in line:
        return                        # про то самое доверие: правила мы передали сами
    print(f"{DIM}{line.rstrip()}{OFF}", file=sys.stderr)


def month_spent(st, add=0.0):
    m = time.strftime("%Y-%m")
    sp = st.setdefault("spent", {})
    sp[m] = round(sp.get(m, 0.0) + add, 4)
    return sp[m]


def short(tool, inp):
    """Что делает инструмент — одной строкой."""
    if tool == "Bash":
        return inp.get("command", "")[:300]
    for k in ("file_path", "path", "pattern", "url", "description", "prompt"):
        if inp.get(k):
            return str(inp[k])[:200]
    return json.dumps(inp, ensure_ascii=False)[:200]


class Agent:
    def __init__(self, cont, st):
        self.st, self.cont = st, cont
        self.client = None
        self.busy = False
        self.allowed = set()          # «всегда» в этом разговоре: (инструмент, команда)
        self.session_cost = 0.0
        self.streamed = False

    async def ask_user(self, tool, inp, ctx):
        """Всё, что не разрешено в .claude/settings.json, спрашиваем здесь."""
        from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny
        what = short(tool, inp)
        if (tool, what) in self.allowed:
            return PermissionResultAllow(updated_input=inp)
        if self.streamed:
            print()
            self.streamed = False
        print(f"\n{BOLD}? {tool}:{OFF} {what}")
        ans = (await asyncio.to_thread(input, "  разрешить? [Enter - да / n - нет / a - всегда в этом разговоре] ")).strip().lower()
        if ans in ("", "y", "д", "да", "a", "ф"):
            if ans in ("a", "ф"):
                self.allowed.add((tool, what))
            return PermissionResultAllow(updated_input=inp)
        why = (await asyncio.to_thread(input, "  почему нет / что сделать вместо (можно пусто): ")).strip()
        return PermissionResultDeny(message=why or "хозяин запретил это действие", interrupt=False)

    def options(self, cont):
        from claude_agent_sdk import ClaudeAgentOptions
        allow, deny = project_rules()
        return ClaudeAgentOptions(
            cwd=str(PROJECT),
            system_prompt={"type": "preset", "preset": "claude_code", "append": STYLE},
            setting_sources=["project"],      # CLAUDE.md и .claude/settings.json проекта, не личные
            permission_mode="acceptEdits",    # правки файлов — без вопросов (откат: git)
            can_use_tool=self.ask_user,
            allowed_tools=allow,              # чтение, git diff, ./tg status|pull|logs — без вопросов
            disallowed_tools=deny,            # git push, .env и сессии — никогда
            stderr=cli_stderr,
            model=self.st.get("model", "opus"),
            continue_conversation=cont,
            include_partial_messages=True,
        )

    async def start(self, cont):
        from claude_agent_sdk import ClaudeSDKClient
        if self.client:
            await self.client.disconnect()
        self.client = ClaudeSDKClient(self.options(cont))
        await self.client.connect()

    def show(self, m):
        from claude_agent_sdk import (AssistantMessage, ResultMessage, StreamEvent, TextBlock,
                                      ToolUseBlock, UserMessage, ToolResultBlock)
        if isinstance(m, StreamEvent):
            ev = m.event or {}
            if m.parent_tool_use_id is None and ev.get("type") == "content_block_delta" \
                    and (ev.get("delta") or {}).get("type") == "text_delta":
                print(ev["delta"].get("text", ""), end="", flush=True)
                self.streamed = True
        elif isinstance(m, AssistantMessage):
            sub = m.parent_tool_use_id is not None
            for b in m.content:
                if isinstance(b, TextBlock) and not sub and not self.streamed:
                    print(b.text)
                elif isinstance(b, ToolUseBlock):
                    if self.streamed:
                        print()
                    print(f"{DIM}{'    ' if sub else '  '}→ {b.name}: {short(b.name, b.input or {})}{OFF}")
            if self.streamed:
                print()
            self.streamed = False
        elif isinstance(m, UserMessage) and isinstance(m.content, list):
            for b in m.content:
                if isinstance(b, ToolResultBlock) and b.is_error:
                    text = b.content if isinstance(b.content, str) else json.dumps(b.content, ensure_ascii=False)
                    print(f"{DIM}{RED}    ✗ {str(text).strip().splitlines()[0][:200] if text else 'ошибка'}{OFF}")
        elif isinstance(m, ResultMessage):
            cost = m.total_cost_usd or 0.0
            self.session_cost += cost
            month = month_spent(self.st, cost)
            save_state(self.st)
            err = f" · {RED}{m.subtype}{OFF}{DIM}" if m.is_error else ""
            print(f"\n{DIM}  ${cost:.3f} за ответ · ${self.session_cost:.2f} за разговор · "
                  f"${month:.2f} за месяц (оценка, точно - platform.claude.com/usage){err}{OFF}")

    async def turn(self, text):
        self.busy = True
        try:
            await self.client.query(text)
            async for m in self.client.receive_response():
                self.show(m)
        finally:
            self.busy = False
            self.streamed = False

    def on_sigint(self):
        if self.busy:
            print(f"\n{DIM}  останавливаю…{OFF}")
            asyncio.ensure_future(self.client.interrupt())
        else:
            print(f"\n{DIM}  выход - /exit или Ctrl+D{OFF}")


def read_prompt():
    first = input(f"\n{BOLD}ты>{OFF} ")
    if first.strip() != '"""':
        return first
    lines = []
    while True:
        ln = input()
        if ln.strip() == '"""':
            return "\n".join(lines)
        lines.append(ln)


async def main():
    args = sys.argv[1:]
    cont = "-c" in args
    first = " ".join(a for a in args if a != "-c").strip()
    os.environ["ANTHROPIC_API_KEY"] = api_key()
    # иначе Claude Code взял бы вход по подписке или чужой токен — платила бы не та сторона
    for k in ("ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"):
        os.environ.pop(k, None)
    try:
        import readline  # noqa: F401 — стрелки и история в вводе
    except ImportError:
        pass
    st = load_state()
    ag = Agent(cont, st)
    print(f"{DIM}папка {PROJECT} · модель {st.get('model', 'opus')} · /exit - выход, Ctrl+C - стоп{OFF}")
    await ag.start(cont)
    asyncio.get_running_loop().add_signal_handler(signal.SIGINT, ag.on_sigint)
    try:
        while True:
            if first:
                text, first = first, ""
            else:
                try:
                    text = (await asyncio.to_thread(read_prompt)).strip()
                except EOFError:
                    break
            if not text:
                continue
            if text in ("/exit", "/quit", "выход"):
                break
            if text == "/cost":
                print(f"  разговор ${ag.session_cost:.2f} · месяц ${month_spent(st):.2f} (оценка)")
                continue
            if text.startswith("/model"):
                name = text.split(maxsplit=1)[1].strip() if " " in text else ""
                if name:
                    await ag.client.set_model(name)
                    st["model"] = name
                    save_state(st)
                print(f"  модель: {st.get('model', 'opus')}")
                continue
            if text == "/new":
                await ag.start(False)
                ag.allowed.clear()
                print("  новый разговор")
                continue
            await ag.turn(text)
    finally:
        if ag.client:
            await ag.client.disconnect()


if __name__ == "__main__":
    try:
        from claude_agent_sdk import CLINotFoundError  # noqa: F401
    except ImportError:
        sys.exit("нет claude-agent-sdk — поставь: bash deploy/laptop/setup.sh (или ./tg agent)")
    asyncio.run(main())
