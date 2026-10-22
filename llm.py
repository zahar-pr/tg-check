#!/usr/bin/env python3
"""
Тонкий провайдер-агностичный клиент к LLM (OpenAI-совместимый /chat/completions).

Настройка — через .env рядом с панелью (секреты не в коде):
  LLM_BASE_URL   базовый URL (https://api.deepseek.com | https://openrouter.ai/api/v1 | …)
  LLM_API_KEY    ключ
  LLM_MODEL      id модели
  LLM_PROXY      (опц.) http://user:pass@host:port — если сервер к провайдеру напрямую не ходит
  LLM_BUDGET     (опц.) месячный потолок в рублях-эквиваленте (мягкая страховка, тут не тарифицируем)

Сменить провайдера = поменять эти переменные, код не трогаем. Ноль зависимостей (stdlib).
"""
import json
import os
import subprocess
import time
from pathlib import Path

CODE = Path(__file__).resolve().parent
# Ключи берём сначала из папки профиля, потом общие — рядом с кодом. Так у
# профиля может быть свой ключ, а может не быть вовсе: тогда работает общий.
DIR = Path(os.environ["TG_PANEL_DIR"]).resolve() if os.environ.get("TG_PANEL_DIR") else CODE
LAST_ERR = ""


def _load_env():
    env = {}
    try:
        src = next((b / ".env" for b in (DIR, CODE) if (b / ".env").exists()), None)
        if src is None:
            return env
        for line in src.read_text("utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except Exception:
        pass
    return env


_ENV = _load_env()


def _cfg(k, d=""):
    return os.environ.get(k) or _ENV.get(k, d)


def chat(system, user, max_tokens=400, temperature=0.8, tries=5, model=None, info=None, timeout=90):
    """Один запрос к модели через curl (надёжно тоннелит HTTPS через прокси).
    Возвращает текст ответа или None (мягкий фейл, причина в LAST_ERR).
    info — словарь, куда положить код сбоя: "net" (сеть, таймаут), "429"/"5xx"
    (перегрузка — после всех повторов), иначе код ошибки запроса ("400"…).
    Свой словарь на вызов: LAST_ERR общий и в потоках перемешивается.
    model — своя модель для задачи (комментарии); имя вида «провайдер/модель»
    понимает только агрегатор (OpenRouter), у прямого провайдера берём LLM_MODEL.
    timeout — секунд на один ответ: длинный список модель пишет дольше 90 с."""
    global LAST_ERR
    LAST_ERR = ""
    base = _cfg("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    key = _cfg("LLM_API_KEY")
    if model and "/" in model and "openrouter" not in base:
        model = None
    model = model or _cfg("LLM_MODEL", "deepseek-chat")
    proxy = _cfg("LLM_PROXY")
    if not key:
        LAST_ERR = "нет LLM_API_KEY в .env"
        return None
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": max_tokens, "temperature": temperature,
    })
    cmd = ["curl", "-s", "-m", str(int(timeout)), "-X", "POST", base + "/chat/completions",
           "-H", "Authorization: Bearer " + key, "-H", "Content-Type: application/json",
           "-H", "X-Title: tg-panel", "-H", "HTTP-Referer: https://bqa.egor-kochnev.ru",
           "-d", body]
    if proxy:
        cmd[1:1] = ["--proxy", proxy]
    delay = 3
    for i in range(tries):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10).stdout
            d = json.loads(out)
        except Exception as e:
            LAST_ERR = f"{type(e).__name__}: {str(e)[:120]}"
            if info is not None:
                info["code"] = "net"
            if i < tries - 1:
                time.sleep(delay); delay *= 2; continue
            return None
        if isinstance(d, dict) and d.get("choices"):
            return (d["choices"][0]["message"]["content"] or "").strip()
        err = (d.get("error") or {}) if isinstance(d, dict) else {}
        code = err.get("code") or (err.get("metadata") or {}).get("provider_error_code")
        LAST_ERR = str(err.get("message") or d)[:180]
        if info is not None:
            info["code"] = str(code or "")
        if str(code) in ("429", "500", "502", "503") and i < tries - 1:
            time.sleep(delay); delay *= 2; continue
        return None
    return None


if __name__ == "__main__":
    print("модель:", _cfg("LLM_MODEL"), "| база:", _cfg("LLM_BASE_URL"), "| прокси:", bool(_cfg("LLM_PROXY")))
    r = chat("Отвечай по-русски одним словом.", "Скажи: работает")
    print("ответ:", r if r is not None else f"НЕТ ({LAST_ERR})")
