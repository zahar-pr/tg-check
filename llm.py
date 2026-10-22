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

Сбер ГигаЧат — отдельный провайдер (chat(..., provider="gigachat")), им
работает обогащение (вкладка «Лиды»):
  GIGACHAT_CREDENTIALS  ключ авторизации (base64 «client_id:secret» из кабинета)
  GIGACHAT_SCOPE        GIGACHAT_API_PERS (физлицо, по умолчанию) | _B2B | _CORP
  GIGACHAT_MODEL        GigaChat-2 (по умолчанию) | GigaChat-2-Pro | GigaChat-2-Max
  GIGACHAT_CA           корневой сертификат Минцифры (по умолчанию
                        russian_trusted_root_ca.pem рядом с кодом)
  GIGACHAT_PROXY        (опц.) прокси; LLM_PROXY ГигаЧату не передаётся —
                        ему нужен российский адрес, а не зарубежный
Проверка с сервера: python llm.py --gigachat
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
                v = v.strip()
                if len(v) > 1 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]                     # KEY="значение" — кавычки не часть значения
                env[k.strip()] = v
    except Exception:
        pass
    return env


_ENV = _load_env()


def _cfg(k, d=""):
    return os.environ.get(k) or _ENV.get(k, d)


MAX_TOKENS_UP = 16000      # потолок, до которого поднимаем лимит при пустом ответе


def chat(system, user, max_tokens=400, temperature=0.8, tries=5, model=None, info=None, timeout=90,
         provider=None):
    """Один запрос к модели через curl (надёжно тоннелит HTTPS через прокси).
    Возвращает текст ответа или None (мягкий фейл, причина в LAST_ERR).
    info — словарь, куда положить код сбоя: "net" (сеть, таймаут), "429"/"5xx"
    (перегрузка — после всех повторов), иначе код ошибки запроса ("400"…).
    Свой словарь на вызов: LAST_ERR общий и в потоках перемешивается.
    model — своя модель для задачи (комментарии); имя вида «провайдер/модель»
    понимает только агрегатор (OpenRouter), у прямого провайдера берём LLM_MODEL.
    timeout — секунд на один ответ: длинный список модель пишет дольше 90 с.
    provider — "gigachat": тот же запрос в Сбер ГигаЧат (см. шапку файла).

    «Думающая» модель тратит max_tokens и на рассуждения: при маленьком лимите
    до ответа она не доходит (пусто, finish_reason=length). Тогда повторяем сами
    с лимитом побольше (до MAX_TOKENS_UP) — платим за потраченное, не за потолок."""
    global LAST_ERR
    LAST_ERR = ""
    if provider == "gigachat":
        return _giga_chat(system, user, max_tokens, temperature, tries, info, timeout)
    base = _cfg("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/")
    key = _cfg("LLM_API_KEY")
    if model and "/" in model and "openrouter" not in base:
        model = None
    model = model or _cfg("LLM_MODEL", "deepseek-chat")
    proxy = _cfg("LLM_PROXY")
    if not key:
        LAST_ERR = "нет LLM_API_KEY в .env"
        return None
    def command(limit, wait):
        body = json.dumps({
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": limit, "temperature": temperature,
        })
        cmd = ["curl", "-s", "-m", str(int(wait)), "-X", "POST", base + "/chat/completions",
               "-H", "Authorization: Bearer " + key, "-H", "Content-Type: application/json",
               "-H", "X-Title: tg-panel", "-H", "HTTP-Referer: https://bqa.egor-kochnev.ru",
               "-d", body]
        if proxy:
            cmd[1:1] = ["--proxy", proxy]
        return cmd

    cmd = command(max_tokens, timeout)
    delay = 3
    raised = 0
    i = 0
    while i < tries:
        i += 1
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10).stdout
            d = json.loads(out)
        except Exception as e:
            LAST_ERR = f"{type(e).__name__}: {str(e)[:120]}"
            if info is not None:
                info["code"] = "net"
            if i < tries:
                time.sleep(delay); delay *= 2; continue
            return None
        if isinstance(d, dict) and d.get("choices"):
            ch = d["choices"][0]
            text = (ch.get("message", {}).get("content") or "").strip()
            if not text:
                # модели с рассуждениями тратят лимит токенов на «подумать» и
                # до ответа не доходят: finish_reason=length — дело в лимите
                why = ch.get("finish_reason") or ""
                if why == "length" and max_tokens < MAX_TOKENS_UP and raised < 2:
                    raised += 1
                    max_tokens = min(MAX_TOKENS_UP, max(max_tokens * 4, 4000))
                    timeout = max(timeout, 180)
                    cmd = command(max_tokens, timeout)
                    i -= 1                      # это не сбой — попытку не тратим
                    continue
                LAST_ERR = ("пустой ответ: модель потратила весь лимит токенов на рассуждения"
                            if why == "length" else f"пустой ответ ({why or 'без причины'})")
            return text
        err = (d.get("error") or {}) if isinstance(d, dict) else {}
        code = err.get("code") or (err.get("metadata") or {}).get("provider_error_code")
        LAST_ERR = str(err.get("message") or d)[:180]
        if info is not None:
            info["code"] = str(code or "")
        if str(code) in ("429", "500", "502", "503") and i < tries:
            time.sleep(delay); delay *= 2; continue
        return None
    return None


# ───────────────────────────── Сбер ГигаЧат ─────────────────────────────

GIGA_OAUTH = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
GIGA_API = "https://gigachat.devices.sberbank.ru/api/v1"
GIGA_TOKEN = DIR / ".gigachat-token.json"      # токен живёт 30 минут — общий для задач профиля


def gigachat_ready():
    return bool(_cfg("GIGACHAT_CREDENTIALS"))


def _giga_ca():
    ca = _cfg("GIGACHAT_CA") or str(CODE / "russian_trusted_root_ca.pem")
    return ca if Path(ca).exists() else ""


def _giga_curl(args, timeout, proxy=True):
    """curl к ГигаЧату: (http-код, тело) или (None, текст ошибки сети)."""
    cmd = ["curl", "-s", "-m", str(int(timeout)), "-w", "\n%{http_code}"]
    ca = _giga_ca()
    if ca:
        cmd += ["--cacert", ca]
    if proxy and _cfg("GIGACHAT_PROXY"):
        cmd += ["--proxy", _cfg("GIGACHAT_PROXY")]
    try:
        r = subprocess.run(cmd + args, capture_output=True, text=True, timeout=timeout + 10)
    except Exception as e:
        return None, f"{type(e).__name__}: {str(e)[:120]}"
    if r.returncode != 0 and not r.stdout:
        why = {60: "сертификат: нет корневого сертификата Минцифры (python llm.py --gigachat скажет, как поставить)",
               35: "TLS: соединение сброшено", 28: "таймаут", 7: "нет соединения", 6: "не нашли адрес"}
        return None, f"curl {r.returncode}: {why.get(r.returncode, r.stderr.strip()[:120])}"
    body, _, code = r.stdout.rpartition("\n")
    return code.strip(), body


def _giga_token(fresh=False):
    """Токен доступа (30 минут): из кеша профиля или новый. (токен, ошибка)."""
    if not fresh:
        try:
            t = json.loads(GIGA_TOKEN.read_text("utf-8"))
            if t.get("exp", 0) / 1000 - time.time() > 60:
                return t["token"], ""
        except Exception:
            pass
    import uuid
    scope = _cfg("GIGACHAT_SCOPE", "GIGACHAT_API_PERS")
    code, body = _giga_curl(["-X", "POST", GIGA_OAUTH,
                             "-H", "Authorization: Basic " + _cfg("GIGACHAT_CREDENTIALS"),
                             "-H", "RqUID: " + str(uuid.uuid4()),
                             "-H", "Content-Type: application/x-www-form-urlencoded",
                             "-H", "Accept: application/json",
                             "--data-urlencode", "scope=" + scope], 30)
    if code is None:
        return "", body
    try:
        d = json.loads(body)
    except Exception:
        d = {}
    if code != "200" or not d.get("access_token"):
        return "", f"вход в ГигаЧат: {code} {str(d.get('message') or body)[:120]} (scope {scope})"
    try:
        tmp = GIGA_TOKEN.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"token": d["access_token"], "exp": d.get("expires_at", 0)}), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(GIGA_TOKEN)
    except Exception:
        pass
    return d["access_token"], ""


def _giga_chat(system, user, max_tokens, temperature, tries, info, timeout):
    """chat() для ГигаЧата: тот же уговор — текст, "" или None с причиной в LAST_ERR."""
    global LAST_ERR

    def fail(code, msg):
        global LAST_ERR
        LAST_ERR = msg[:200]
        if info is not None:
            info["code"] = code
        return None

    if not gigachat_ready():
        return fail("401", "нет GIGACHAT_CREDENTIALS в .env")
    model = _cfg("GIGACHAT_MODEL", "GigaChat-2")
    delay, raised, refreshed, i = 3, 0, False, 0
    while i < tries:
        i += 1
        token, err = _giga_token(fresh=refreshed)
        if not token:
            # не пустили — это ключ/доступ, а не перегрузка: повторять незачем
            return fail("net" if err.startswith("curl") else "401", err)
        body = json.dumps({
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            # ГигаЧат хочет температуру строго больше нуля
            "max_tokens": max_tokens, "temperature": max(float(temperature), 0.01), "stream": False,
        })
        code, out = _giga_curl(["-X", "POST", GIGA_API + "/chat/completions",
                                "-H", "Authorization: Bearer " + token,
                                "-H", "Content-Type: application/json", "-H", "Accept: application/json",
                                "-d", body], timeout)
        if code is None:
            if i < tries:
                time.sleep(delay); delay *= 2; continue
            return fail("net", out)
        try:
            d = json.loads(out)
        except Exception:
            d = {}
        if code == "200" and d.get("choices"):
            ch = d["choices"][0]
            text = (ch.get("message", {}).get("content") or "").strip()
            why = ch.get("finish_reason") or ""
            if why == "blacklist":
                # сработал фильтр тем ГигаЧата — отказ именно в этом запросе
                return fail("400", "ГигаЧат отказался отвечать: тема под его фильтром")
            if not text and why == "length" and max_tokens < MAX_TOKENS_UP and raised < 2:
                raised += 1
                max_tokens = min(MAX_TOKENS_UP, max(max_tokens * 4, 4000))
                timeout = max(timeout, 180)
                i -= 1
                continue
            if not text:
                LAST_ERR = f"пустой ответ ({why or 'без причины'})"
            return text
        msg = str(d.get("message") or out)[:160]
        if code == "401" and not refreshed:
            refreshed = True                          # токен протух раньше срока — новый
            i -= 1
            continue
        if code in ("429", "500", "502", "503", "504") and i < tries:
            time.sleep(delay); delay *= 2; continue
        if code == "402":
            return fail("402", "ГигаЧат: кончились токены по ключу (402)")
        return fail("400" if code in ("400", "413", "422") else code, f"ГигаЧат {code}: {msg}")
    return None


def gigachat_check():
    """python llm.py --gigachat — вход, модели, остаток токенов, пробный ответ. Без секретов."""
    print("ключ:", "есть" if gigachat_ready() else "НЕТ (GIGACHAT_CREDENTIALS в .env)")
    ca = _giga_ca()
    print("сертификат Минцифры:", ca or "НЕТ — поставь:\n  curl -fsSL https://gu-st.ru/content/lending/"
          "russian_trusted_root_ca_pem.crt -o " + str(CODE / "russian_trusted_root_ca.pem"))
    if not gigachat_ready():
        return
    token, err = _giga_token(fresh=True)
    if not token:
        print("вход: НЕТ —", err)
        return
    print("вход: да, scope", _cfg("GIGACHAT_SCOPE", "GIGACHAT_API_PERS"))
    for path, title in (("/models", "модели"), ("/balance", "остаток токенов")):
        code, out = _giga_curl([GIGA_API + path, "-H", "Authorization: Bearer " + token,
                                "-H", "Accept: application/json"], 30)
        try:
            d = json.loads(out or "{}")
        except Exception:
            d = {}
        if path == "/models" and code == "200":
            print(f"{title}:", ", ".join(m.get("id", "?") for m in d.get("data", [])))
        elif path == "/balance" and code == "200":
            print(f"{title}:", "; ".join(f"{b.get('usage')}: {b.get('value')}" for b in d.get("balance", [])) or "—")
        else:
            print(f"{title}: {code} {str(d.get('message') or out)[:120]}")
    info = {}
    t0 = time.time()
    r = chat("Отвечай по-русски одним словом.", "Скажи: работает", max_tokens=50, temperature=0.1,
             info=info, provider="gigachat")
    print(f"модель {_cfg('GIGACHAT_MODEL', 'GigaChat-2')}: ответ «{r}» за {time.time() - t0:.1f} с"
          if r else f"модель: НЕТ — {LAST_ERR} ({info.get('code', '')})")


if __name__ == "__main__":
    import sys
    if "--gigachat" in sys.argv:
        gigachat_check()
        raise SystemExit
    print("модель:", _cfg("LLM_MODEL"), "| база:", _cfg("LLM_BASE_URL"), "| прокси:", bool(_cfg("LLM_PROXY")))
    r = chat("Отвечай по-русски одним словом.", "Скажи: работает")
    print("ответ:", r if r is not None else f"НЕТ ({LAST_ERR})")
