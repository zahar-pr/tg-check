#!/usr/bin/env python3
"""
Общее для всех задач на Telethon: аккаунты, сессии, прокси, чтение баз.

Раньше вся работа шла через Telegram Web в Playwright — кликами по разметке.
Теперь то же самое делается родным каналом Telegram (MTProto): быстрее,
без браузера и без гадания по вёрстке. Реестр аккаунтов остался общий
(accounts.json), поэтому панель видит одни и те же аккаунты в обоих режимах.

Ключ авторизации у Telethon лежит в своём файле:  sessions/<id>.session
Папки профилей Chromium (tg-profile, accounts/<id>) не трогаем — они всё
ещё нужны старым скриптам на Playwright.
"""
import asyncio
import csv
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


# Код один на всех профилей, данные у каждого свои. CODE — где лежат сами
# задачи и образцы, DIR — папка данных профиля; её задаёт панель через
# TG_PANEL_DIR. Без переменной всё работает по-старому, в одной папке.
CODE = Path(__file__).resolve().parent
DIR = Path(os.environ["TG_PANEL_DIR"]).resolve() if os.environ.get("TG_PANEL_DIR") else CODE
ACCOUNTS = DIR / "accounts.json"
SESSIONS = DIR / "sessions"
# Два набора получателей: «по номерам» (корень) и «по чатам» (chats/). Какой в
# работе, говорит панель через TG_SET; разбор чатов пишет в свой набор всегда.
CHATS_DIR = DIR / "chats"
SET = "chats" if os.environ.get("TG_SET") == "chats" else "phones"
_SET_DIR = CHATS_DIR if SET == "chats" else DIR
NUMBERS = _SET_DIR / "numbers.csv"
RESULTS = _SET_DIR / "results.csv"
DRAFTS = _SET_DIR / "drafts.csv"
CHAT_NUMBERS = CHATS_DIR / "numbers.csv"
CHAT_RESULTS = CHATS_DIR / "results.csv"
ALL_DRAFTS = (DIR / "drafts.csv", CHATS_DIR / "drafts.csv")   # история отправок аккаунта — общая
MEMBERS = DIR / "members.csv"    # участники чатов, собранные разбором
# кому ушло первое письмо — по id Telegram: по нему проверка ответов узнаёт
# человека, даже если ник сменился или номер скрыт (followup.py)
SENT_IDS = DIR / "sent-ids.csv"
SENT_IDS_HEAD = ["key", "user_id", "account", "at"]
WARMUP = DIR / "warmup.csv"      # что аккаунты делали на прогреве
WARM_LIST = DIR / "warm-list.json"           # куда прогрев их водит (правит хозяин)
WARM_LIST_DEFAULT = CODE / "warm-list.default.json"  # образец, приезжает с кодом
MESSAGE = DIR / "message.txt"
MESSAGE_CHAT = DIR / "message-chat.txt"  # отдельный текст для собранных из чатов
# запасной текст для чатов — тем, у кого нет полей таблицы, на которых держится
# основной (нет бренда для {brand}): иначе ушло бы «Нашёл  на маркетплейсе»
MESSAGE_CHAT_PLAIN = DIR / "message-chat-plain.txt"
QUEUE_FIRST = DIR / "queue-first.txt"   # кому писать раньше всех: ключ на строку, по порядку
EXTRAS = DIR / "extras.csv"   # кастомные поля под сообщение: ключ человека → колонки
PARTS = DIR / "message-parts.json"   # сборный текст: приветствие + суть + призыв
MIRROR = DIR / "mirror.json"         # текущий субдомен-зеркало для {LINK}
VOICE = DIR / "voice.ogg"          # голосовое для рассылки (ogg/opus)
VOICE_META = DIR / "voice.json"    # его имя и длительность

# ── api_id/hash: ДЕСКТОП по умолчанию, МОБИЛЬНЫЙ при своём api_id ──────────────
# 2040 — публичный api_id Telegram DESKTOP; на нём честный отпечаток — Desktop.
# Чтобы аккаунт выглядел как ТЕЛЕФОН (мобильный прокси + мобильный отпечаток),
# нужен СВОЙ api_id (my.telegram.org): Android-устройство на 2040 — рассинхрон
# «десктоп на телефоне». Свой api_id кладётся в tgapi.json рядом с данными:
#     {"apiId": 12345, "apiHash": "..."}
# Пока его нет — всё работает на 2040/Desktop, ничего не ломается и не меняется.
DEFAULT_API_ID, DEFAULT_API_HASH = 2040, "b18441a1ff607e10a989891a5462e627"
API_FILE = DIR / "tgapi.json"


def _global_api():
    """Свой (мобильный) api_id из tgapi.json, если задан. Иначе None."""
    try:
        d = json.loads(API_FILE.read_text("utf-8"))
        if d.get("apiId") and d.get("apiHash"):
            return int(d["apiId"]), str(d["apiHash"])
    except Exception:
        pass
    return None


def api_for(acc):
    """api_id/hash аккаунта: своё поле > общий tgapi.json > публичный 2040."""
    if acc.get("apiId") and acc.get("apiHash"):
        return int(acc["apiId"]), str(acc["apiHash"])
    return _global_api() or (DEFAULT_API_ID, DEFAULT_API_HASH)


def is_mobile(acc):
    """Аккаунт на СВОЁМ (не 2040) api_id → отпечаток берём мобильный (Android)."""
    return api_for(acc)[0] != DEFAULT_API_ID


# Обратная совместимость со старым кодом, который читал модульные константы.
API_ID, API_HASH = DEFAULT_API_ID, DEFAULT_API_HASH

# Отпечаток по умолчанию (когда device ещё не закреплён, но сессия уже живая).
DEVICE = dict(device_model="Desktop", system_version="Windows 10",
              app_version="4.9.9", lang_code="ru", system_lang_code="ru")

# Под каким устройством аккаунт заходит в Telegram.
#
# ВАЖНО про согласованность. Тип отпечатка ДОЛЖЕН совпадать с api_id:
#   • api_id 2040 (Telegram DESKTOP) → отпечаток Desktop (DESKTOP_VARIANTS);
#   • свой api_id (мобильное приложение) → отпечаток Android (MOBILE_VARIANTS).
# Desktop-ключ с моделью телефона на api_id 2040 — рассинхрон «десктоп на
# телефоне», сам по себе подозрителен. Пул выбирается по is_mobile(acc).
# Меняем только модель/версии, чтобы аккаунты не были байт-в-байт одинаковыми.
#
# Применяется при новом входе (fresh login) и закрепляется в accounts.json.
# У живой сессии отпечаток сам не трогаем; принудительный перебив — repin_device().
DESKTOP_VARIANTS = [
    ("Desktop", "Windows 10 x64", "4.16.8"),
    ("Desktop", "Windows 11 x64", "5.1.2"),
    ("Desktop", "Windows 10 x64", "5.2.3"),
    ("Desktop", "Windows 11 x64", "5.3.1"),
    ("PC 64bit", "Windows 10", "4.14.9"),
    ("Desktop", "Windows 11 x64", "5.5.1"),
    ("Desktop", "Windows 10 x64", "5.5.5"),
    ("PC 64bit", "Windows 11", "5.6.3"),
    ("Desktop", "Windows 10 x64", "5.7.2"),
    ("Desktop", "Windows 11 x64", "5.8.3"),
    ("Desktop", "macOS 14.5", "11.2.2"),
    ("Desktop", "macOS 15.1", "11.4.1"),
    ("PC 64bit", "Windows 10 x64", "5.2.3"),
    ("Desktop", "Windows 11 x64", "5.1.7"),
    ("Desktop", "Windows 10 x64", "4.16.6"),
    ("Desktop", "Windows 11 x64", "5.6.1"),
    ("Desktop", "Ubuntu 24.04", "5.5.1"),
    ("Desktop", "Windows 10 x64", "5.3.0"),
]

# Мобильный пул (Android): реальные модели + правдоподобные версии Telegram for
# Android. Применяется ТОЛЬКО когда у аккаунта свой api_id (is_mobile) — иначе
# был бы рассинхрон с Desktop-api_id 2040. По одному фиксированному устройству на
# аккаунт, не вращать. Версии при необходимости обновлять (t.me/tgstable).
MOBILE_VARIANTS = [
    ("Samsung Galaxy S24", "Android 14", "11.4.0"),
    ("Samsung Galaxy S23", "Android 14", "11.6.1"),
    ("Samsung Galaxy S24 Ultra", "Android 15", "11.9.0"),
    ("Samsung Galaxy A55", "Android 14", "11.7.0"),
    ("Samsung Galaxy A54", "Android 14", "11.5.1"),
    ("Samsung Galaxy S22", "Android 14", "11.8.2"),
    ("Google Pixel 8", "Android 15", "11.9.1"),
    ("Google Pixel 8 Pro", "Android 15", "11.11.0"),
    ("Google Pixel 7", "Android 14", "11.6.1"),
    ("Google Pixel 9 Pro", "Android 15", "12.0.1"),
    ("Xiaomi 14", "Android 14", "11.7.0"),
    ("Xiaomi 13", "Android 14", "11.5.1"),
    ("Redmi Note 13 Pro", "Android 14", "11.8.0"),
    ("Redmi Note 12", "Android 13", "11.4.0"),
    ("POCO X6 Pro", "Android 14", "11.9.0"),
    ("OnePlus 12", "Android 14", "11.10.0"),
    ("OnePlus 11", "Android 14", "11.6.1"),
    ("OnePlus Nord 3", "Android 14", "11.5.1"),
    ("realme 11 Pro", "Android 14", "11.7.1"),
    ("vivo V30", "Android 14", "11.8.1"),
    ("OPPO Reno 11", "Android 14", "11.6.0"),
    ("HONOR 90", "Android 14", "11.5.0"),
    ("Samsung Galaxy S21 FE", "Android 13", "11.4.1"),
    ("Google Pixel 7a", "Android 14", "11.10.1"),
]


def _variant_pool(acc):
    """Пул отпечатков под api_id аккаунта: Android для своего api_id, иначе Desktop."""
    return MOBILE_VARIANTS if is_mobile(acc) else DESKTOP_VARIANTS


def _pick_variant(acc):
    """Свободный уникальный вариант из нужного пула — не повторяем занятую пару
    (система+версия), чтобы аккаунты не были одинаковыми."""
    import random
    pool = _variant_pool(acc)
    taken = {(str((a.get("device") or {}).get("system_version", "")),
              str((a.get("device") or {}).get("app_version", "")))
             for a in load_accounts() if a.get("id") != acc.get("id")}
    free = [v for v in pool if (v[1], v[2]) not in taken]
    model, system, app = random.choice(free or pool)
    return {"device_model": model, "system_version": system, "app_version": app}


def device_for(acc):
    """
    Параметры устройства аккаунта.

    Порядок такой:
      • записаны в accounts.json — берём их (родные данные от продавца или то,
        что мы закрепили при входе);
      • ещё не записаны, сессия живая, аккаунт десктопный (2040) — оставляем
        умолчание Desktop: менять отпечаток живой сессии задним числом опаснее;
      • ещё не записаны, но аккаунт мобильный (свой api_id) ИЛИ сессии ещё нет —
        выдаём свой вариант из нужного пула и закрепляем (для мобильного Desktop-
        умолчание было бы рассинхроном «десктоп на телефоне»).
    """
    d = acc.get("device")
    if isinstance(d, dict) and d.get("device_model"):
        out = dict(DEVICE)
        out.update({k: v for k, v in d.items() if v})
        return out

    if session_path(acc).exists() and not is_mobile(acc):
        return dict(DEVICE)

    picked = _pick_variant(acc)
    set_field(acc["id"], device=picked)
    acc["device"] = picked
    out = dict(DEVICE)
    out.update(picked)
    return out


def ensure_device(acc):
    """
    Закрепить СВОЙ отпечаток перед входом, если его ещё нет. Вызывается скриптами
    входа ДО connect, чтобы новая сессия сразу завелась под уникальным и
    согласованным с api_id устройством (Desktop или Android по is_mobile), а не
    под общим умолчанием. У кого device уже записан (родной/наш) — не трогаем.
    """
    d = acc.get("device")
    if isinstance(d, dict) and d.get("device_model"):
        return d
    picked = _pick_variant(acc)
    set_field(acc["id"], device=picked)
    acc["device"] = picked
    return picked


def repin_device(acc):
    """
    Принудительно закрепить НОВЫЙ уникальный отпечаток из нужного пула — даже если
    device уже стоит и сессия живая. Для планового перебива (напр. перевод старых
    аккаунтов на мобильный api_id). Для Telegram это обновление метки устройства
    существующей авторизации, а не новый вход.
    """
    picked = _pick_variant(acc)
    set_field(acc["id"], device=picked)
    acc["device"] = picked
    return picked


async def harden_account(client, acc):
    """
    После входа: завершить ВСЕ прочие сессии аккаунта, кроме этой (панель —
    единственный сеанс). Так чужой/старый вход (продавца, прежнего устройства)
    не висит и не ловит коды, а параллельная авторизация не роняет нашу.
    Telegram запрещает сброс в первые 24 ч жизни новой сессии — тогда тихо
    пропускаем (панель спросит снова в следующий раз). Выключается env
    TG_KEEP_OTHER_SESSIONS=1.
    """
    if os.environ.get("TG_KEEP_OTHER_SESSIONS") == "1":
        return
    try:
        from telethon.tl.functions.auth import ResetAuthorizationsRequest
    except Exception:
        return
    try:
        await client(ResetAuthorizationsRequest())
        say("✓ завершил остальные сеансы аккаунта — панель единственный вход")
    except Exception as e:
        name = type(e).__name__
        if "Fresh" in name or "Forbidden" in name or "24" in str(e):
            say("другие сеансы пока не сбросить (Telegram не даёт в первые 24 ч нового входа)")
        else:
            say(f"не смог завершить другие сеансы: {name}")

# боевые адреса дата-центров: нужны, когда сессию собираем из голого ключа
DC_IP = {1: "149.154.175.53", 2: "149.154.167.51", 3: "149.154.175.100",
         4: "149.154.167.91", 5: "91.108.56.130"}

# kept=1 — после проверки человек остался в контактах проверившего аккаунта:
# писать ему будет этот же аккаунт, и повторно тратить квоту на добавление не нужно
RESULTS_HEAD = ["phone", "tg", "name", "username", "calls", "last_call", "checked_at", "by", "kept"]
DRAFTS_HEAD = ["phone", "account", "ok", "sent", "at"]
MEMBERS_HEAD = ["key", "username", "name", "user_id", "chat", "at", "by"]
WARMUP_HEAD = ["account", "action", "target", "note", "at"]


# ---------------------------------------------------------------- аккаунты

# Telethon сам пишет в лог каждую неудачную попытку соединения; в журнале
# панели это выглядит паникой на ровном месте — оставляем только настоящие
# ошибки, а причину недоступности объясняем своими словами (NO_NET).
logging.getLogger("telethon").setLevel(logging.ERROR)


def load_accounts():
    try:
        data = json.loads(ACCOUNTS.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


import contextlib as _contextlib


@_contextlib.contextmanager
def _accounts_lock():
    """
    Замок на accounts.json, общий с панелью (accounts.mjs): простой lock-файл
    через O_EXCL — его одинаково понимают Python и Node (flock бы не совпал).
    Нужен, потому что с параллелью файл правят сразу несколько процессов, и
    «прочитал-изменил-записал» без замка теряет чужую правку.
    """
    lock = str(ACCOUNTS) + ".lock"
    fd = None
    t0 = time.time()
    while fd is None:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock) > 10:   # краш с незакрытым замком — крадём
                    os.unlink(lock); continue
            except OSError:
                pass
            if time.time() - t0 > 5:
                break                                            # не дождались — пишем без замка
            time.sleep(0.04)
    try:
        if fd is not None:
            os.write(fd, str(os.getpid()).encode())
        yield
    finally:
        if fd is not None:
            os.close(fd)
            with _contextlib.suppress(OSError):
                os.unlink(lock)


def save_accounts(lst):
    # атомарно: tmp + rename — читатель не получит обрезанный файл и пустой список
    tmp = str(ACCOUNTS) + ".tmp." + str(os.getpid())
    Path(tmp).write_text(json.dumps(lst, ensure_ascii=False, indent=2) + "\n", "utf-8")
    os.replace(tmp, ACCOUNTS)


def resolve(acc_id=""):
    """id -> запись аккаунта. Без id берём первый: запуск из терминала без --account."""
    lst = load_accounts()
    if not lst:
        raise SystemExit("нет ни одного аккаунта — заведи его в панели (шаг 1)")
    if not acc_id:
        return lst[0]
    for a in lst:
        if a.get("id") == acc_id:
            return a
    raise SystemExit(f"аккаунт «{acc_id}» не найден")


def session_path(acc) -> Path:
    """Файл сессии Telethon. Своё поле в реестре важнее умолчания."""
    SESSIONS.mkdir(exist_ok=True)
    raw = acc.get("session")
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else DIR / p
    return SESSIONS / f"{acc['id']}.session"


def set_field(acc_id, **fields):
    """Правит запись аккаунта в реестре, не трогая остальные поля. Под общим
    замком: чтение и запись атомарны относительно панели и других задач."""
    with _accounts_lock():
        lst = load_accounts()
        for a in lst:
            if a.get("id") == acc_id:
                a.update(fields)
                save_accounts(lst)
                return True
    return False


def remember(acc, me):
    """
    Запоминает, кто на самом деле стоит за аккаунтом: имя, @ и телефон.
    Панель показывает это в списке — иначе после добавления видно только
    придуманное название, и понять, вошёл аккаунт или нет, нельзя.
    Переданный словарь обновляем тоже: вызывающий работает с ним дальше.
    """
    name = " ".join(x for x in [me.first_name, me.last_name] if x).strip()
    fields = {"authed": True, "name": name, "username": me.username or "",
              "phone": me.phone or "", "user_id": me.id}
    acc.update(fields)
    set_field(acc["id"], **fields)
    return name


def who(acc):
    """Аккаунт одной строкой: то, что видно и в панели, и в журнале."""
    parts = [acc.get("name") or "", f"@{acc['username']}" if acc.get("username") else "",
             f"+{str(acc['phone']).lstrip('+')}" if acc.get("phone") else ""]
    return " · ".join(p for p in parts if p) or str(acc.get("user_id") or "")


def has_session(acc) -> bool:
    return session_path(acc).exists()


# ------------------------------------------------------------------ прокси

def parse_proxy(raw):
    """
    Строка прокси -> кортеж для Telethon (python_socks).

    Понимаем всё, чем их обычно продают:
        1.2.3.4:8000                 (без схемы считаем socks5)
        1.2.3.4:8000:логин:пароль
        socks5://логин:пароль@1.2.3.4:1080
        http://логин:пароль@1.2.3.4:8000
    Пустая строка -> None: аккаунт ходит с вашего адреса.
    """
    s = str(raw or "").strip()
    if not s:
        return None
    scheme, rest = "socks5", s
    if "://" in s:
        scheme, rest = s.split("://", 1)
        scheme = scheme.lower()
    user = password = None
    if "@" in rest:
        cred, rest = rest.rsplit("@", 1)
        user, _, password = cred.partition(":")
    parts = rest.split(":")
    if len(parts) == 4:                       # host:port:user:pass
        host, port, user, password = parts
    elif len(parts) == 2:
        host, port = parts
    else:
        raise SystemExit(f"не разобрал прокси «{s}» — нужно host:port")
    if not host or not port.isdigit():
        raise SystemExit(f"не разобрал прокси «{s}» — нужно host:port")
    kind = "socks5" if "socks5" in scheme else "socks4" if "socks4" in scheme else "http"
    if user:
        return (kind, host, int(port), True, user, password or "")
    return (kind, host, int(port))


def proxy_label(raw):
    """Как показать прокси человеку: без пароля."""
    try:
        p = parse_proxy(raw)
    except SystemExit:
        return "прокси задан с ошибкой"
    if not p:
        return "прямой IP"
    who = f" ({p[4]}:***)" if len(p) > 4 else ""
    return f"{p[0]}://{p[1]}:{p[2]}{who}"


# ------------------------------------------------------------------ клиент

def make_client(acc, **kw):
    """Клиент Telethon для аккаунта: своя сессия, свой прокси, вид десктопа."""
    from telethon import TelegramClient
    path = session_path(acc)
    if not path.exists():
        raise SystemExit(
            f"у аккаунта «{acc.get('title', acc.get('id'))}» нет сессии Telethon.\n"
            f"Подключи её: python import-account.py --account {acc['id']} --session файл.session\n"
            f"или, если он уже входил в браузере: "
            f"python import-account.py --account {acc['id']} --from-profile")
    opts = device_for(acc)
    # Опыт на трафик: задачи панели короткие и событий Telegram не ждут (ответы
    # SpamBot и людей читаются запросом), поэтому обновления, которые Telegram
    # шлёт подключённому клиенту, им не нужны. По умолчанию ВЫКЛЮЧЕНО — включать
    # флагом TG_NO_UPDATES=1 и сначала мерить на тестовом профиле: как это
    # выглядит для антиспама Telegram, заранее неизвестно.
    if os.environ.get("TG_NO_UPDATES") == "1":
        opts["receive_updates"] = False
    opts.update(kw)
    api_id, api_hash = api_for(acc)
    return TelegramClient(str(path.with_suffix("")), api_id, api_hash,
                          proxy=parse_proxy(acc.get("proxy")),
                          connection_retries=3, timeout=20, **opts)


def quiet_telethon():
    """
    Заткнуть трейсбеки из фоновых задач Telethon.

    Когда Telegram отвечает «ключ не знаю», исключение достаётся не только нам,
    но и внутренней задаче-отправителю. Питон при выходе печатает её как
    «Future exception was never retrieved» — целую портянку поверх нашего
    короткого вердикта. Человеку в журнале панели это только мешает: мы уже
    сказали словами, что случилось.
    """
    def handler(loop, ctx):
        exc = ctx.get("exception")
        if exc is not None and type(exc).__name__ in ("AuthKeyNotFound", "AuthKeyUnregisteredError",
                                                      "ConnectionError", "CancelledError"):
            return
        loop.default_exception_handler(ctx)

    try:
        asyncio.get_event_loop().set_exception_handler(handler)
    except RuntimeError:
        pass


NO_NET = ("не достучаться до Telegram по MTProto.\n"
          "Обычно это блокировка провайдера: включи VPN или пропиши аккаунту прокси,\n"
          "через который проходит Telegram (проверить: python proxy-check.py --account %s).")


TRAFFIC = DIR / "traffic.csv"     # сколько трафика съела каждая задача (через какой прокси)
TRAFFIC_HEAD = ["at", "account", "task", "proxy", "up", "down"]


def _sock_bytes(peer=""):
    """
    Сколько байт прошло через TCP-сокеты этого процесса (ss -ti): (отправлено,
    получено). peer — «host:port» прокси: тогда считаем только соединения с ним,
    чтобы запросы мимо прокси (например, к LLM) не попадали в его трафик.
    """
    import subprocess
    pid = f"pid={os.getpid()},"
    try:
        lines = subprocess.run(["ss", "-tinpH"], capture_output=True, text=True, timeout=5).stdout.splitlines()
    except Exception:
        return 0, 0
    up = down = 0
    for i, ln in enumerate(lines):
        if pid not in ln or (peer and f"{peer} " not in ln and f"{peer}\t" not in ln):
            continue
        info = lines[i + 1] if i + 1 < len(lines) else ""
        s = re.search(r"bytes_sent:(\d+)", info) or re.search(r"bytes_acked:(\d+)", info)
        r = re.search(r"bytes_received:(\d+)", info)
        up += int(s.group(1)) if s else 0
        down += int(r.group(1)) if r else 0
    return up, down


def _log_traffic(client):
    """
    Записать, сколько трафика съела задача. Прокси платный за гигабайт —
    без этой строки не видно, на что он уходит: Asocks знает только общий итог.
    Считаем по сокетам процесса перед отключением; прокси — адрес без логина.
    """
    acc = getattr(client, "_tg_acc", None)
    if not acc:
        return
    p = parse_proxy(acc.get("proxy"))
    proxy = f"{p[1]}:{p[2]}" if p else "direct"
    up, down = _sock_bytes(proxy if p else "")
    if not (up or down):
        return
    task = Path(sys.argv[0]).stem
    try:
        append_row(TRAFFIC, [now_iso(), acc.get("id", ""), task, proxy, up, down], TRAFFIC_HEAD)
    except Exception:
        pass    # учёт — вспомогательное, задачу из-за него не роняем


async def aclose(client):
    """
    Отключение, глотающее ошибки уборки. На Python 3.13 Telethon 1.44 иногда
    падает на disconnect() («attempt to write a readonly database» при
    сохранении состояния) — это шаг уборки уже ПОСЛЕ вердикта, и он не должен
    ни ронять задачу, ни маскировать настоящую причину трейсбеком.
    Перед отключением записываем трафик задачи (traffic.csv).
    """
    try:
        _log_traffic(client)
    except Exception:
        pass
    try:
        await client.disconnect()
    except Exception:
        pass


def _exit_country(proxy_raw):
    """Код страны выхода через прокси (ipinfo по http, ~1 КБ). None — не определили."""
    try:
        p = parse_proxy(proxy_raw)
    except SystemExit:
        return None
    if not p:
        return None
    kind, host, port = p[0], p[1], p[2]
    cred = f"{p[4]}:{p[5]}@" if len(p) > 4 and p[4] else ""
    url = f"{kind}://{cred}{host}:{port}"
    import subprocess
    try:
        out = subprocess.run(["curl", "-s", "-m", "15", "-x", url, "http://ipinfo.io/json"],
                             capture_output=True, text=True, timeout=20).stdout
        return (json.loads(out) or {}).get("country") or None
    except Exception:
        return None


async def connect(acc, **kw):
    """
    Подключение с проверкой живости. Мёртвый ключ помечаем в реестре: панель
    покажет «нет входа», и аккаунт не пойдёт в работу молча.

    Отсутствие связи и мёртвый ключ — разные вещи, и путать их нельзя:
    из-за первого аккаунт нельзя записывать в нерабочие.
    """
    from telethon.errors.common import AuthKeyNotFound

    # ПОЛНЫЙ отдых после заморозки (fullRestUntil): никакая задача не
    # подключает аккаунт к Telegram вовсе — ни письма, ни прогрев, ни чтение
    # ответов, ни SpamBot. Здесь последний рубеж для всех задач сразу.
    # («Без рассылки», sendHoldUntil, сюда не относится: прогрев подключается.)
    rest = full_rest_left(acc)
    if rest > 0:
        raise SystemExit(f"«{acc.get('title', acc['id'])}» на полном отдыхе после заморозки ещё "
                         f"{rest // 3600} ч {rest % 3600 // 60} мин — к Telegram не подключаю")

    # Защита от входа из чужой страны. Мобильный пул иногда выпускает «казахстанский»
    # прокси через другую страну (видели выход из Марокко/Колумбии/Германии), а
    # скачки страны между входами Telegram считает угоном и сбрасывает сессию.
    # Поэтому ПЕРЕД подключением к Telegram проверяем страну выхода: не KZ — не
    # подключаемся вовсе (Telegram не увидит аккаунт из-за границы). Если страну
    # не определили (прокси молчит/429) — не блокируем, это решит сторож.
    # Выключается TG_REQUIRE_COUNTRY=off.
    need = os.environ.get("TG_REQUIRE_COUNTRY", "KZ")
    if need and need != "off" and acc.get("proxy"):
        c = _exit_country(acc.get("proxy"))
        if c and c != need:
            set_field(acc["id"], driftCountry=c, driftAt=now_iso())
            raise SystemExit(f"прокси сейчас выходит из {c}, а не {need} — не подключаю "
                             f"«{acc.get('title', acc['id'])}» (чтобы Telegram не увидел вход из-за границы). "
                             "Сменить IP и повторить.")

    quiet_telethon()
    client = make_client(acc, **kw)
    client._tg_acc = acc          # для учёта трафика при отключении (aclose)
    try:
        await client.connect()
    except AuthKeyNotFound:
        # ключ Telegram больше не признаёт: отозвали в «Устройствах» или
        # аккаунт забанен. Помечаем в реестре, чтобы панель не звала его в работу
        set_field(acc["id"], authed=False)
        await aclose(client)
        raise SystemExit(f"Telegram не знает ключ аккаунта «{acc.get('title', acc['id'])}» — "
                         "сессия мертва или отозвана. Подключи её заново.")
    except (OSError, asyncio.TimeoutError) as e:
        await aclose(client)
        raise SystemExit(f"{type(e).__name__}: " + NO_NET % acc["id"])
    if not await client.is_user_authorized():
        set_field(acc["id"], authed=False)
        await aclose(client)
        raise SystemExit(f"сессия «{acc.get('title', acc['id'])}» мертва или отозвана — подключи заново")
    me = await client.get_me()
    remember(acc, me)
    await save_avatar(client, acc, me)
    return client


AVATARS = DIR / "avatars"
AVATAR_TTL = 24 * 3600       # чаще раза в сутки аватарку не перекачиваем


async def save_avatar(client, acc, me=None, force=False):
    """
    Маленькая аватарка аккаунта для панели — чтобы в списке было видно, кто
    есть кто. Берём при подключении, которое и так случилось (прогрев,
    проверка, рассылка), не чаще раза в сутки: отдельных заходов в Telegram
    ради картинки не делаем. Нет фото — кладём пометку .none, чтобы не
    спрашивать каждый раз. Сбой тут работе не мешает.
    """
    import time
    pic, none = AVATARS / f"{acc['id']}.jpg", AVATARS / f"{acc['id']}.none"
    fresh = next((p for p in (pic, none) if p.exists()), None)
    if not force and fresh and time.time() - fresh.stat().st_mtime < AVATAR_TTL:
        return
    try:
        AVATARS.mkdir(exist_ok=True)
        got = await client.download_profile_photo(me or "me", file=str(pic), download_big=False)
        if got:
            none.unlink(missing_ok=True)
        else:
            pic.unlink(missing_ok=True)
            none.touch()
    except Exception:
        pass


# --------------------------------------------------------------------- CSV

def read_csv(path):
    """Список словарей. Нет файла — пустой список, как в старых скриптах."""
    p = Path(path)
    if not p.exists():
        return []
    with p.open(newline="", encoding="utf-8") as f:
        return [dict(r) for r in csv.DictReader(f) if any(v for v in r.values())]


def _csv_line(values):
    """Одна строка CSV как текст — чтобы записать её единым write()."""
    import io
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerow(values)
    return buf.getvalue()


def ensure_head(path, head):
    """
    Заводит файл с шапкой, если его ещё нет. Вызывать ДО параллельной дозаписи:
    тогда сама дозапись шапкой не занимается и гонки за неё нет.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)     # набор «по чатам» живёт в chats/
    if not p.exists() or p.stat().st_size == 0:
        p.write_text(_csv_line(head), "utf-8")


def append_row(path, row, head):
    """
    Дописывает строку. По одному файлу пишут сразу несколько процессов
    (проверка/рассылка идут параллельно), поэтому строку кладём ОДНИМ write()
    в режиме дозаписи: O_APPEND делает такую запись атомарной — строки не
    смешиваются, и файловый замок (который на этой связке ФС мог вставать
    намертво) не нужен. Шапку заводит ensure_head() до параллельного прогона;
    если файла всё же нет, первую строку предваряем шапкой в том же write().
    """
    p = Path(path)
    line = _csv_line(row)
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists() or p.stat().st_size == 0:
        line = _csv_line(head) + line
    with p.open("a", encoding="utf-8") as f:
        f.write(line)


def ensure_results_head(path=None):
    """
    Колонка by (каким аккаунтом проверено) появилась вместе с мультиаккаунтом.
    У старого файла её нет — дописываем шапку, не теряя результатов.
    """
    path = path or RESULTS
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(",".join(RESULTS_HEAD) + "\n", "utf-8")
        return
    raw = path.read_text("utf-8")
    first = raw.split("\n", 1)[0]
    if ",by" not in first or ",kept" not in first:
        # у старых строк новых колонок просто нет — читаются как пустые
        rest = raw.split("\n", 1)[1] if "\n" in raw else ""
        path.write_text(",".join(RESULTS_HEAD) + "\n" + rest, "utf-8")


def migrate_drafts_log():
    """
    Лог черновиков раньше был phone,ok,at — без аккаунта и без отметки отправки.
    Дописываем недостающие колонки, приписывая старые строки первому аккаунту.
    Возвращает число переведённых строк.
    """
    head = ",".join(DRAFTS_HEAD) + "\n"
    if not DRAFTS.exists():
        DRAFTS.parent.mkdir(parents=True, exist_ok=True)
        DRAFTS.write_text(head, "utf-8")
        return 0
    raw = DRAFTS.read_text("utf-8").strip()
    if not raw:
        DRAFTS.write_text(head, "utf-8")
        return 0
    lines = raw.split("\n")
    # переводим ТОЛЬКО ровно старую шапку: прогон по уже новому файлу
    # сдвинул бы колонки и стёр отметки времени
    if lines[0].strip() != "phone,ok,at":
        return 0
    first = (load_accounts() or [{}])[0].get("id", "")
    out = []
    for line in lines[1:]:
        if not line.strip():
            continue
        v = (line.split(",") + ["", "", ""])[:3]
        out.append(f"{v[0]},{first},{v[1]},,{v[2]}")
    DRAFTS.write_text(head + "\n".join(out) + ("\n" if out else ""), "utf-8")
    return len(out)


# ------------------------------------------------------- получатели без номера

"""
Ключ получателя.

Панель выросла из проверки телефонов, поэтому колонка ключа в numbers.csv и
results.csv называется phone. Но писать можно и тем, у кого номера нет вовсе:
участникам чата, собранным разбором. Такие люди живут в тех же файлах и в той
же очереди, только ключ у них другой:

    +79001234567   номер — его ещё надо проверить (есть ли Telegram)
    @username      человек из чата: пишем прямо по имени, проверять нечего
    id:123456789   он же, но без @username — только для того аккаунта,
                   который его нашёл: чужая сессия такой id не развернёт

Одно правило на весь код: по первому символу ключа видно, что это. Проверка
номеров берёт только phone-ключи, рассылка — любые.
"""


def is_phone(key) -> bool:
    """Ключ — телефон (а не человек из чата)."""
    return str(key or "").startswith("+")


def member_key(username="", user_id="") -> str:
    """Ключ для человека из чата: @username, а без него — id:<id>."""
    u = str(username or "").strip().lstrip("@")
    if u:
        return "@" + u
    return f"id:{user_id}" if user_id else ""


# ------------------------------------------------------- сборка сообщения

PART_KEYS = ("hello", "body", "call")


def load_parts():
    """Что человек набрал в трёх полях панели. Нет файла — пусто."""
    try:
        d = json.loads(PARTS.read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def part_lines(data, key):
    """Строки одного блока: пустые выбрасываем, порядок сохраняем."""
    return [ln.strip() for ln in str(data.get(key, "")).splitlines() if ln.strip()]


def parts_ready(data=None):
    """Собирать текст по блокам можно, только если включено и все три не пусты."""
    d = data if data is not None else load_parts()
    if not d.get("on"):
        return False
    return all(part_lines(d, k) for k in PART_KEYS)


def spin(text):
    """
    Разворачивает «варианты» в тексте: {так|или так|или вот так} → одно из
    случайно. Так пишут живые люди — одно письмо, а в нём отмечены места,
    которые можно сказать по-разному, и на каждого выбирается свой вариант.

    Группой-вариантом считается только {...} С ЧЕРТОЙ внутри. Обычные
    подстановки — {name}, {date}, {LINK} — черты не содержат и остаются
    нетронутыми. Вложенность поддерживается: {Привет{|,}|Здравствуйте}.
    Пустой вариант — это просто пропуск: «Привет{|, друг}» даст «Привет»
    или «Привет, друг».
    """
    import random
    # разбираем изнутри наружу: находим самую внутреннюю {...} без вложенных
    # скобок и, если в ней есть черта, заменяем случайным вариантом; повторяем
    inner = re.compile(r"\{([^{}]*)\}")
    for _ in range(100):                 # защита от бесконечного цикла
        m = inner.search(text)
        if not m:
            break
        body = m.group(1)
        if "|" in body:
            choice = random.choice(body.split("|"))
        else:
            # это подстановка ({name} и т.п.) — не трогаем, но чтобы regex
            # не нашёл её снова, временно прячем маркером
            choice = "\x00" + body + "\x01"
        text = text[:m.start()] + choice + text[m.end():]
    return text.replace("\x00", "{").replace("\x01", "}")


# Подстановки пишут руками — «{ name}», «{Name}», «{имя}», а рассылка ищет ровно
# {name}: письмо ушло бы человеку с фигурными скобками («Добрый день{ name}!» —
# 16.10 так ушло 123 письма). Тот же разбор — fixPlaceholders в admin.mjs.
PH_ALIAS = {"name": "name", "имя": "name", "date": "date", "дата": "date",
            "username": "username", "ник": "username", "chat": "chat", "чат": "chat",
            "link": "LINK", "ссылка": "LINK"}
PH_KNOWN = ("name", "date", "username", "chat", "LINK", "link")


def fix_placeholders(text):
    """Приводит подстановки к виду, который понимает рассылка; варианты {а|б} не трогает."""
    def one(m):
        body = m.group(1).strip()
        return "{" + PH_ALIAS.get(body.lower(), body) + "}"
    return re.sub(r"\{([^{}|]*)\}", one, text or "")


def bad_placeholders(text, known=PH_KNOWN):
    """Подстановки, которых рассылка не знает, и непарные скобки: человеку они ушли бы как есть."""
    if not text:
        return []
    bad = ["{" + b + "}" for b in re.findall(r"\{([^{}|]*)\}", text) if b not in known]
    if text.count("{") != text.count("}"):
        bad.append("непарная фигурная скобка")
    return bad


def spin_count(text):
    """
    Сколько непохожих сообщений даёт текст со spintax. Для наглядности в панели:
    произведение числа вариантов во всех группах. Обычные {name} не в счёт.
    """
    n = 1
    for body in re.findall(r"\{([^{}]*)\}", text):
        if "|" in body:
            n *= len(body.split("|"))
    # вложенные группы этот грубый счётчик занижает — и ладно, это ориентир
    return n


def current_link():
    """
    Ссылка, которой панель заменяет {LINK} в тексте.

    Её ведёт панель (Node): каждые 30–50 писем берётся новый субдомен-зеркало
    на Vercel, чтобы одна ссылка не светилась во всей рассылке. Здесь только
    читаем, что панель записала. Зеркала выключены — отдаём базовый домен,
    если он задан, иначе пусто.
    """
    try:
        d = json.loads(MIRROR.read_text("utf-8"))
    except Exception:
        return ""
    if d.get("on") and d.get("url"):
        return d["url"]
    base = d.get("base", "")
    return f"https://{base}" if base else ""


def build_message(data=None):
    """
    Собрать одно сообщение: из каждого блока по случайной строке, склеить
    пробелом.

    Смысл в том, что у двух писем не совпадает ни текст, ни его отпечаток:
    одинаковые сообщения, разосланные пачкой, Telegram узнаёт именно по хэшу,
    и дальше страдают все аккаунты сразу, а не тот, который попался.
    """
    import random
    d = data if data is not None else load_parts()
    return " ".join(random.choice(part_lines(d, k)) for k in PART_KEYS)


def parts_count(data=None):
    """Сколько всего непохожих сообщений даёт нынешний набор блоков."""
    d = data if data is not None else load_parts()
    n = 1
    for k in PART_KEYS:
        n *= max(0, len(part_lines(d, k)))
    return n


# ------------------------------------------------- ограничения на аккаунте

SPAM_BOT = "SpamBot"

# Ответы @SpamBot дословно, как он их пишет. Ловить отдельные слова нельзя:
# «свободен от каких-либо ОГРАНИЧЕНИЙ» и «аккаунт ОГРАНИЧЕН» отличаются
# ровно одним словом, и поиск подстроки принимает здоровый аккаунт за битый.
SPAM_FREE = (
    "no limits are currently applied",
    "free as a bird",
    "not limited",
    "свободен от каких-либо ограничений",
    "свободен от ограничений",
    "никаких ограничений",
    "не ограничен",
)
SPAM_LIMITED = (
    "account is limited",
    "account was limited",
    "i'm afraid",
    "some actions can trigger a harsh response",
    "will not be able to send messages",
    "ваш аккаунт ограничен",
    "аккаунт ограничен",
    "аккаунт временно ограничен",
    "ограничен до",
    "ограничения будут автоматически сняты",
    "жалоба была обоснованной",
    "я боюсь",
)

# Заморозка — это НЕ временный лимит. Telegram блокирует аккаунт по жалобам
# получателей после ручной модерации; сам срок не снимается, нужен разбан.
# SpamBot отвечает так даже замороженному аккаунту, поэтому ловим именно текст.
SPAM_BLOCK = (
    "your account was blocked",
    "account has been blocked",
    "violations of the telegram terms of service",
    "confirmed by our moderators",
    "account was frozen",
    "ваш аккаунт заблокирован",
    "аккаунт был заблокирован",
    "аккаунт заморожен",
    "ваш аккаунт заморожен",
    "нарушение условий использования",
)

# «Ограничения будут автоматически сняты 29 Sep 2026, 08:32 UTC» /
# «will be automatically released on 29 Sep 2026, 08:32 UTC» — дата снятия
_SPAM_UNTIL = re.compile(r"(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4}),? (\d{1,2}):(\d{2}) UTC")
_MON = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def spam_until(text):
    """Когда Telegram снимет ограничение (UTC, ISO) — или "" если срока нет."""
    m = _SPAM_UNTIL.search(text or "")
    if not m or m.group(2).lower()[:3] not in _MON:
        return ""
    d, mon, y, hh, mm = m.groups()
    return datetime(int(y), _MON[mon.lower()[:3]], int(d), int(hh), int(mm),
                    tzinfo=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def spam_reason(text):
    """Коротко — за что ограничили, человеческим языком."""
    low = (text or "").lower()
    if "пожаловал" in low or "нежелательн" in low or "reported" in low or "complain" in low:
        return "жалоба на спам: писать можно только тем, у кого твой номер в контактах"
    return "Telegram ограничил отправку незнакомым"


def spam_verdict(text):
    """
    Разобрать ответ @SpamBot: свободен аккаунт или придержан.

    Сначала ищем прямое «свободен», потом прямое «ограничен». Порядок важен:
    в объяснении про свободу тоже встречается слово «ограничения».

    Ответ, который не подошёл ни под что, считаем плохим и говорим об этом
    словами: ошибиться в сторону «поработай завтра» дешевле, чем погнать
    в рассылку аккаунт, которому Telegram уже сделал замечание.

    Возвращает (свободен, короткая выжимка ответа).
    """
    # бот пишет типографский апостроф, а в наших приметах обычный
    t = " ".join(str(text or "").replace("\u2019", "'").split())
    low = t.lower()
    if not low:
        return False, "бот не ответил"
    # Заморозку проверяем ПЕРВОЙ: это жёсткая блокировка, важнее любого лимита.
    if spam_blocked(t):
        return False, t[:200]
    if any(w in low for w in SPAM_FREE):
        return True, t[:200]
    if any(w in low for w in SPAM_LIMITED):
        return False, t[:200]
    return False, "не понял ответ бота: " + t[:160]


def spam_blocked(text) -> bool:
    """Заморожен ли аккаунт — жёсткая блокировка по жалобам (ToS), не временный лимит."""
    low = " ".join(str(text or "").replace("’", "'").split()).lower()
    return any(w in low for w in SPAM_BLOCK)


def is_frozen_error(e) -> bool:
    """
    Ошибка Telegram именно о ЗАМОРОЗКЕ аккаунта (FROZEN_METHOD_INVALID и родня),
    а не случайная строка со словом frozen (frozenset, frozen dataclass и т.п.).
    Замороженному аккаунту Telegram валит FROZEN_* почти на любой метод отправки.
    """
    # Только ошибки Telegram: в тексте ValueError/SystemExit бывает чужой ник или
    # ссылка («@frozen_food_ekb»), и здоровый аккаунт записали бы в замороженные.
    # Код ошибки — в e.message (FROZEN_METHOD_INVALID), у известных Telethon —
    # ещё и имя класса (FrozenMethodInvalidError, FrozenParticipantMissingError…)
    try:
        from telethon.errors import RPCError
    except ImportError:
        return False
    if not isinstance(e, RPCError):
        return False
    return (type(e).__name__.startswith("Frozen")
            or str(getattr(e, "message", "") or "").upper().startswith("FROZEN_"))


def _until_left(acc, key) -> int:
    """Сколько секунд осталось до отметки времени acc[key] (ISO), 0 — прошла или нет её."""
    v = acc.get(key)
    if not v:
        return 0
    try:
        until = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        # вписали руками без пояса («2026-10-20») — считаем UTC, как Date.parse в панели
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return max(0, int((until - datetime.now(timezone.utc)).total_seconds()))
    except Exception:
        return 0


def full_rest_left(acc) -> int:
    """
    ПОЛНЫЙ отдых после заморозки (fullRestUntil): аккаунт не подключается к
    Telegram вовсе — ни писем, ни прогрева, ни ответов. Секунд до конца, 0 — нет.
    """
    return _until_left(acc, "fullRestUntil")


def send_hold_left(acc) -> int:
    """
    Сколько секунд аккаунту ещё нельзя писать людям, 0 — можно.

    sendHoldUntil — «без рассылки»: холодных писем нет, а прогреваться можно
    (реакции, каналы, переписка со своими). Полный отдых — тем более без писем.
    Запрет стоит на уровне самой задачи: роль в панели можно случайно
    переключить одним «ОК» при запуске, а отметку — только руками.
    """
    return max(_until_left(acc, "sendHoldUntil"), full_rest_left(acc))


# когда с какого прокси последний раз уходило письмо — общий на профиль
SEND_GAP = DIR / ".send-gap.json"
SEND_GAP_LOCK = DIR / ".send-gap.lock"
SEND_GAP_GIVE_UP = 15 * 60     # дольше ждать соседей незачем — что-то не так, пишем


async def wait_send_gap(acc, gap_min, gap_max):
    """
    Не дать двум аккаунтам написать с одного IP почти одновременно.

    По очереди такого не бывает: пишет кто-то один. В параллели аккаунты на
    общем прокси стартуют в один тик и уходят залпом — два-три письма с одного
    адреса в одну секунду (14.10: a3 и a2 в 18:10:57–58, a1 через 5 с после a2,
    и a1 заморозили). Для Telegram это прямой признак фермы.

    Перед каждым письмом смотрим, когда с ЭТОГО ЖЕ прокси последний раз уходило
    письмо любым аккаунтом профиля, и если раньше паузы — ждём и смотрим снова.
    Свою паузу между своими письмами аккаунт держит как раньше, тут только
    разводим разных между собой. Возвращает, сколько прождали, сек.

    Сломаться тут ничто не должно: человек к этому моменту уже найден (а по
    номерам — заведён в контакты), и упавший разнос сжёг бы попытку. Если
    замок или файл недоступны (права, битый JSON) — выдерживаем паузу вслепую.
    """
    import random
    try:
        return await _wait_send_gap(acc, gap_min, gap_max)
    except Exception as e:
        say(f"разнос писем: {type(e).__name__} — выдерживаю паузу вслепую")
        w = random.uniform(gap_min, max(gap_min, gap_max))
        await asyncio.sleep(w)
        return w


async def _wait_send_gap(acc, gap_min, gap_max):
    import fcntl
    import random
    import time
    key = str(acc.get("proxy") or "").strip() or "direct"
    gap = random.uniform(gap_min, max(gap_min, gap_max))
    waited = 0.0
    while True:
        with open(SEND_GAP_LOCK, "a+") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            try:
                seen = json.loads(SEND_GAP.read_text("utf-8")) if SEND_GAP.exists() else {}
                seen = seen if isinstance(seen, dict) else {}
                last = float(seen.get(key, 0) or 0)
            except Exception:
                seen, last = {}, 0.0
            now = time.time()
            # метка из будущего (перевели часы, битый файл) — не повод ждать вечно
            last = min(last, now)
            left = last + gap - now
            if left <= 0 or waited >= SEND_GAP_GIVE_UP:
                seen[key] = now
                SEND_GAP.write_text(json.dumps(seen), "utf-8")
                return waited
        # замок на время сна отпускаем — иначе соседи ждали бы не своей очереди
        step = min(left, 30.0) + random.uniform(0.5, 3.0)
        await asyncio.sleep(step)
        waited += step


SPAM_FRESH = 30 * 60          # столько держим прошлый ЧИСТЫЙ вердикт

# Сняли ограничение — сразу писать незнакомым не идём: первое холодное письмо
# после снятия — самый короткий путь к новому, более долгому ограничению.
# Сначала столько «без рассылки» (sendHoldUntil: людям не пишет, прогрев идёт),
# потом письма заново разгоняются с 2 в сутки — день рассылки панель считает
# от конца этого отдыха (server/warmup.mjs). То же число — в admin.mjs.
REST_AFTER_RESTRICTION = 3 * 86400


def hold_after_restriction(acc_id):
    """
    Поля отдыха после снятого ограничения — или {}, если отдых уже стоит
    (его поставила панель по дате снятия или хозяин руками после заморозки).
    """
    cur = next((a for a in load_accounts() if a.get("id") == acc_id), {})
    if _until_left(cur, "sendHoldUntil") > 0:
        return {}
    until = datetime.now(timezone.utc) + timedelta(seconds=REST_AFTER_RESTRICTION)
    return {"sendHoldUntil": until.isoformat(timespec="milliseconds").replace("+00:00", "Z")}


async def spam_check(client, acc, force=False):
    """
    Спросить бота и записать вердикт в реестр аккаунтов.

    Панель смотрит на эти поля: аккаунт с ограничением в рассылку не идёт,
    и в его строке видно, до какого числа он придержан.

    Чистый вердикт получасовой свежести переспрашивать незачем. Раньше письма
    уходили пачками и бота спрашивали раз на пачку; теперь аккаунт пишет по
    одному письму за заход, и вопрос на каждое письмо — это лишний разговор
    через прокси и пять секунд ожидания на ровном месте. Запрет не кешируем
    никогда: ограничение надо увидеть сразу.
    """
    # force=True — не доверять кэшу: перед реальной отправкой холодным нужен
    # свежий ответ бота, иначе заморозка в пределах получаса после чистого
    # вердикта не видна на старте прогона (кэш вернёт «свободен»).
    if not force and acc.get("spamOk") is True and acc.get("spamAt"):
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(
                str(acc["spamAt"]).replace("Z", "+00:00"))).total_seconds()
            if 0 <= age < SPAM_FRESH:
                return True, f"ограничений нет (спрашивали {int(age // 60)} мин назад)"
        except Exception:
            pass
    try:
        await client.send_message(SPAM_BOT, "/start")
        await asyncio.sleep(5)
        msgs = await client.get_messages(SPAM_BOT, limit=1)
        text = (msgs[0].message if msgs else "") or ""
    except Exception as e:
        # Замороженный аккаунт валится FROZEN_* уже на обращении к боту —
        # это не «не дозвонились», а приговор: помечаем и уводим в карантин,
        # иначе main пойдёт «по прошлому вердикту» и пустит его в отправку.
        if is_frozen_error(e):
            set_field(acc["id"], spamOk=False, spamUntil="", spamKind="frozen",
                      spamAt=now_iso(), spam=cell(
                          "заморожен — блокировка по жалобам (ToS), "
                          "снимается только разбаном через @SpamBot/поддержку"))
            return False, "заморожен — блокировка по жалобам (ToS)"
        # не дозвонились до бота — это не приговор аккаунту, прошлый вердикт
        # остаётся в силе
        return None, f"{type(e).__name__}: {str(e).splitlines()[0][:80]}"
    ok, note = spam_verdict(text)
    frozen = spam_blocked(text)
    # у заморозки нет срока снятия — until не ставим, даже если в тексте мелькнёт
    # дата, иначе карантин по дате сам отпустит бессрочно замороженный акк
    until = "" if (ok or frozen) else spam_until(text)
    # заморозка (жалобы+модерация) / временно (есть дата снятия) / бессрочно
    kind = "" if ok else ("frozen" if frozen else "temp" if until else "perm")
    if frozen:
        note = "заморожен — блокировка по жалобам (ToS), снимается только разбаном через @SpamBot/поддержку"
    elif not ok and not note.startswith("не понял"):
        when = ""
        if until:
            local = datetime.fromisoformat(until.replace("Z", "+00:00")).astimezone(
                timezone(timedelta(hours=5)))
            when = f"временно, до {local:%d.%m %H:%M} по Екб"
        note = f"{when or 'бессрочно'} — {spam_reason(text)}"
    fields = dict(spam=cell(note), spamAt=now_iso(), spamOk=ok,
                  spamUntil=until, spamKind=kind)
    # бот сказал «свободен» после ограничения или заморозки — отдых без рассылки
    if ok and acc.get("spamOk") is False:
        fields.update(hold_after_restriction(acc["id"]))
    set_field(acc["id"], **fields)
    acc.update(fields)   # задача дальше смотрит на свежий вердикт и отдых
    return ok, note


def cell(v) -> str:
    """
    Текст, безопасный для наших CSV. Панель (JS) читает эти файлы простым
    разрезанием строки по запятой, без разбора кавычек, — поэтому запятая
    и перевод строки внутри имени сдвинули бы все колонки вправо. Имена
    приходят из Telegram, там бывает что угодно.
    """
    return " ".join(str(v or "").replace(",", " ").split()).strip()


# не имена, хотя в Telegram так подписываются часто
_NOT_NAMES = {"мама", "папа", "бабушка", "дедушка", "сын", "дочь", "любимая", "любимый",
              "user", "admin", "test", "unknown", "deleted", "telegram"}
_NAME = re.compile(r"^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,14}$")


def human_name(first_name):
    """
    Имя для обращения в письме — или "" если на имя не похоже. Берём первое
    слово, только буквы; «Мама», «𝓐𝓷𝓷𝓪» и номера не подставляем, эмодзи вокруг имени отбрасываем:
    лучше «Добрый день!», чем «Добрый день, 🌸Катюша🌸!».
    """
    # «Анастасия| Про преподавание», «Глеб✌️» — берём буквы до первого не-буквы
    m = re.search(r"[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]*", str(first_name or "").strip())
    word = m.group(0).strip("-") if m else ""
    if not _NAME.match(word) or word.lower() in _NOT_NAMES:
        return ""
    return word[0].upper() + word[1:].lower() if word.isupper() or word.islower() else word


async def real_name(client, user):
    """
    Имя, которое человек сам указал в Telegram. Пока он у нас в контактах,
    Telegram отдаёт наше имя контакта (метку из цифр), поэтому спрашиваем,
    когда контакт уже убран. Не вышло — пусто, письмо уйдёт без имени.
    """
    from telethon import functions, types
    try:
        got = await client(functions.users.GetUsersRequest(
            [types.InputUser(user_id=user.id, access_hash=user.access_hash)]))
        return human_name(got[0].first_name if got else "")
    except Exception:
        return ""


def chat_title(title):
    """
    Название чата для текста письма: без эмодзи и значков, одной строкой.
    «💥Рощинская 26💥 Чат дома» → «Рощинская 26 Чат дома».
    """
    clean = "".join(ch if (ch.isalnum() or ch in " -|.,()«»\"'№/") else " " for ch in str(title or ""))
    return " ".join(clean.replace('"', "").split()).strip(" -|.,")


def chat_rank_fn():
    """
    Уровень чата для очереди: 0 — самые близкие к теме, дальше по порядку,
    последним — всё, что не подошло. Уровни и слова — в chat-priority.txt;
    слово с «=» впереди — точное название чата, а не кусок.
    """
    levels = []
    try:
        for line in (DIR / "chat-priority.txt").read_text("utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if ":" in line:
                levels.append([w.strip().lower() for w in line.split(":", 1)[1].split(",") if w.strip()])
    except Exception:
        pass
    # «=название» — только этот чат целиком: короткое «чат екатеринбург» иначе
    # цепляло бы и «Бизнес чат Екатеринбург»
    def hit(w, low):
        return w[1:].strip() == low if w.startswith("=") else w in low
    def rank(title):
        low = str(title or "").lower()
        return next((i for i, words in enumerate(levels) if any(hit(w, low) for w in words)), len(levels))
    return rank


def queue_first():
    """Кому писать раньше всех (queue-first.txt): ключ без регистра → место в списке."""
    try:
        lines = QUEUE_FIRST.read_text("utf-8").splitlines()
    except Exception:
        return {}
    out = {}
    for ln in lines:
        k = ln.split("#", 1)[0].strip().lower()
        if k and k not in out:
            out[k] = len(out)
    return out


def chat_of_members():
    """Кого в каком чате нашли: ключ человека → название чата (из members.csv)."""
    return {r["key"]: chat_title(r.get("chat")) for r in read_csv(MEMBERS) if r.get("key")}


def extras_of():
    """Кастомные поля для подстановки в текст (extras.csv).

    Ключ человека (колонка key/phone/username, с @ или без) → {колонка: значение}.
    Колонки произвольные: Бренд→{brand}, ЛПР→{lpr} и т.п. — что положишь в
    таблицу, то и можно подставлять. Возвращает (данные, набор колонок).
    """
    data, cols = {}, set()
    for r in read_csv(EXTRAS):
        k = (r.get("key") or r.get("phone") or r.get("username") or "").strip()
        if not k:
            continue
        fields = {c: (v or "") for c, v in r.items()
                  if c not in ("key", "phone", "username") and c}
        cols |= set(fields)
        for variant in {k, k.lstrip("@"), "@" + k.lstrip("@")}:
            data.setdefault(variant, fields)
    return data, cols


def kept_waiting(acc_id):
    """
    Номера (цифрами), которые проверка оставила в контактах этого аккаунта и
    которым ещё не написали. Их не чистит ни уборка контактов, ни рассылка:
    удалишь — и письмо потратит квоту на повторное добавление.
    Ищем в наборе «по номерам» — только там проверка и оставляет контакты.
    """
    done = {r["phone"] for r in read_csv(DIR / "drafts.csv")
            if r.get("ok") in ("true", "skip") or r.get("sent") == "true"}
    return {"".join(ch for ch in r["phone"] if ch.isdigit())
            for r in read_csv(DIR / "results.csv")
            if r.get("kept") == "1" and r.get("by") == acc_id and r["phone"] not in done}


def can_write(row, acc_id) -> bool:
    """
    Может ли этот аккаунт написать этому человеку.

    Номер и @username доступны любому аккаунту. А человек без @username лежит
    под ключом id:<id>, и развернуть такой id может ТОЛЬКО тот аккаунт, который
    его нашёл: access_hash к человеку выдаётся каждому аккаунту свой и хранится
    в его сессии. Чужому такой человек просто не существует.

    Без этой проверки чужой аккаунт забронировал бы его, не смог написать, и
    после трёх таких попыток человек выпал бы из базы навсегда — при том, что
    аккаунт-сборщик написал бы ему без всяких проблем.
    """
    key = str(row.get("phone", ""))
    # человек лежит в контактах проверившего аккаунта — пишет только он:
    # чужой потратил бы квоту на повторное добавление
    if row.get("kept") == "1":
        return row.get("by", "") == acc_id
    if not key.startswith("id:") or row.get("by", "") == acc_id:
        return True
    # лид обогащения: у него сохранено сообщение в чате (chat_id + msg_id).
    # Любой писатель откроет это сообщение и получит СВОЙ доступ к человеку
    # (draft-messages.find_member), поэтому лид без @username — общий. Но только
    # строка, которую положил сам разбор (by=lead): человека, собранного раньше
    # parse-chat, по-прежнему пишет его сборщик — у того доступ уже есть
    return row.get("by", "") == "lead" and key in lead_refs()


_LEADS_CACHE = {"mtime": None, "refs": {}}


def lead_refs():
    """Ключ получателя -> карточка лида (leads.json); перечитываем при правке файла."""
    f = DIR / "enrich" / "leads.json"
    try:
        mtime = f.stat().st_mtime
    except OSError:
        return {}
    if mtime != _LEADS_CACHE["mtime"]:
        import enrich          # здесь, а не наверху: enrich сам импортирует tglib
        _LEADS_CACHE.update(mtime=mtime, refs=enrich.lead_refs())
    return _LEADS_CACHE["refs"]


def now_iso():
    """Время как его пишет Node: одни и те же файлы читают оба."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def add_recipients(people, by=""):
    """
    Кладёт людей из чатов в набор «по чатам» (chats/), какой бы режим ни был
    выбран в панели: results.csv — очередь рассылки (сразу tg=true: они уже в
    Telegram, иначе их в чате бы не было), numbers.csv — «база», по которой
    панель считает объём работы. С базой клиентов из xlsx они не смешиваются.

    people — словари с полями username / name / user_id.
    Возвращает (добавлено, пропущено-как-дубликаты).
    """
    known = {r.get("phone", "") for r in read_csv(CHAT_RESULTS)}
    in_base = {r.get("phone", "") for r in read_csv(CHAT_NUMBERS)}
    ensure_results_head(CHAT_RESULTS)
    ensure_head(CHAT_NUMBERS, ["phone", "calls", "last_call", "total_sec"])

    added = dup = 0
    at = now_iso()
    for p in people:
        key = member_key(p.get("username"), p.get("user_id"))
        if not key:
            continue
        if key in known:
            dup += 1
            continue
        known.add(key)
        append_row(CHAT_RESULTS,
                   [key, "true", cell(p.get("name")),
                    cell(p.get("username")).lstrip("@"), "", "", at, by],
                   RESULTS_HEAD)
        if key not in in_base:
            in_base.add(key)
            append_row(CHAT_NUMBERS, [key, "", "", ""], ["phone", "calls", "last_call", "total_sec"])
        added += 1
    return added, dup


# ------------------------------------------------------------------- прочее

def voice_duration():
    """Длительность голосового в секундах — её пишет панель при загрузке."""
    try:
        return int(json.loads(VOICE_META.read_text("utf-8")).get("duration", 0))
    except Exception:
        return 0


def arg(name, default=None, argv=None):
    """--имя значение из командной строки."""
    argv = argv if argv is not None else sys.argv
    key = f"--{name}"
    return argv[argv.index(key) + 1] if key in argv and argv.index(key) + 1 < len(argv) else default


def flag(name, argv=None):
    argv = argv if argv is not None else sys.argv
    return f"--{name}" in argv


def say(*a):
    """Печать без буфера: панель читает вывод построчно, пока задача идёт."""
    print(*a, flush=True)


# Итог пачки — панели, а не человеку. Автопрогон по нему решает, звать ли этот
# аккаунт снова, дать ли отлежаться и сколько. В журнал строка не попадает.
STATE_MARK = "\u2301STATE"


def state(done=0, left=0, stop="", cooldown=0, note="", act="", phase=""):
    """
    stop: "" — всё в порядке, можно звать снова;
          "flood"  — Telegram придержал аккаунт (PEER_FLOOD или долгая пауза);
          "quota"  — кончилась дневная квота на контакты;
          "errors" — подряд идут сбои, дальше давить бессмысленно.
    cooldown — сколько секунд аккаунту отдыхать, прежде чем пробовать снова.
    act   — человеческая фраза, что аккаунт сейчас делает / сделал
            («читает ленту и ставит реакцию», «пишет своему аккаунту»);
    phase — "doing" пока действие идёт, "done" когда закончил. Панель по нему
            показывает в прогресс-баре живой статус, а не просто ответ SpamBot.
    """
    print(f"{STATE_MARK} " + json.dumps(
        {"done": done, "left": left, "stop": stop,
         "cooldown": int(cooldown), "note": note, "act": act, "phase": phase},
        ensure_ascii=False), flush=True)


def until_tomorrow():
    """Секунд до начала следующих суток: столько ждать после «квота кончилась»."""
    now = datetime.now()
    start = (now + timedelta(days=1)).replace(hour=0, minute=5, second=0, microsecond=0)
    return max(60, int((start - now).total_seconds()))


def tries_by_phone(rows, spent):
    """
    Сколько раз номер уже брали в работу без толку. Нужно автопрогону: без
    этого номер, который не выходит обработать (нет квоты, странная ошибка),
    возвращался бы в очередь вечно и крутил бы прогон на месте.
    spent — номера, с которыми всё уже решено: их не считаем.
    """
    n = {}
    for r in rows:
        phone = r.get("phone", "")
        if phone and phone not in spent:
            n[phone] = n.get(phone, 0) + 1
    return n


# --------------------------------------------------------- давно не заходил

GONE_DAYS = 60   # дольше этого не заходил в Telegram — не пишем


def long_gone(user):
    """
    Человек давно не заходил в Telegram — писать ему незачем: письмо не
    прочтут, а непрочитанные сообщения незнакомцам портят аккаунту репутацию.

    Точную дату Telegram отдаёт, только если человек её не скрыл — тогда
    отсекаем старше GONE_DAYS. Скрытую — лишь грубо: «недавно», «на неделе»,
    «в этом месяце» или «давно»; последнее (или вовсе без статуса) значит
    больше месяца, точнее не узнать — такого тоже пропускаем.
    """
    from telethon.tl.types import UserStatusEmpty, UserStatusOffline
    st = getattr(user, "status", None)
    if st is None or isinstance(st, UserStatusEmpty):
        return True
    if isinstance(st, UserStatusOffline) and st.was_online:
        return (datetime.now(timezone.utc) - st.was_online).days > GONE_DAYS
    return False


# ------------------------------------------------------------ папка рассылки

OUTREACH_FOLDER = "Рассылка"


async def ensure_outreach_folder(client, acc):
    """
    Папка «Рассылка» в самом аккаунте: все, кому он писал, одним списком —
    удобно открыть аккаунт в Telegram Desktop и пройтись по ответам.

    Список людей в папку не кладём: в обычную папку влезает 100 чатов, а у
    аккаунта их сотни. Папка по правилу — «личные чаты не из контактов»:
    рассылка после письма убирает человека из контактов, поэтому все, кому
    писали, попадают туда сами. Свои аккаунты (переписка прогрева) исключаем
    и обновляем папку на каждом заходе: с новыми своими переписка начинается
    по ходу прогрева. Возвращает True, если папку создали сейчас.
    """
    from telethon import functions, types
    got = await client(functions.messages.GetDialogFiltersRequest())
    filters = getattr(got, "filters", got)
    title_of = lambda f: getattr(getattr(f, "title", None), "text", getattr(f, "title", None))
    mine = next((f for f in filters if title_of(f) == OUTREACH_FOLDER), None)
    used = [f.id for f in filters if hasattr(f, "id")]
    exclude = []
    for a in load_accounts():
        if a.get("id") == acc.get("id") or not a.get("user_id"):
            continue
        try:
            exclude.append(await client.get_input_entity(int(a["user_id"])))
        except Exception:
            pass    # с этим своим ещё не переписывались — в папку он и так не попадёт
    folder = types.DialogFilter(
        id=mine.id if mine else max(used + [1]) + 1,
        title=types.TextWithEntities(text=OUTREACH_FOLDER, entities=[]),
        pinned_peers=[], include_peers=[], exclude_peers=exclude,
        non_contacts=True, emoticon="📨")
    await client(functions.messages.UpdateDialogFilterRequest(id=folder.id, filter=folder))
    return mine is None
