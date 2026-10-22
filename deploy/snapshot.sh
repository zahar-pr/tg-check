#!/usr/bin/env bash
#
# Снимок сервера для разработчика — одним текстовым файлом, БЕЗ секретов:
#   • правки кода на сервере против коммита, который выкладывали (чужие правки);
#   • новые файлы кода на сервере (те, где похоже на секрет, — только имя);
#   • состояние: служба, версии, аккаунты (прокси — только адрес), обогащение;
#   • свежие журналы.
# Сессии, .env, asocks.json, accounts.json целиком, пароли прокси и данные
# людей в снимок не попадают. Всё, что выводится, ещё раз чистится от
# похожего на ключи и пароли.
#
#     bash deploy/snapshot.sh --base <коммит выложенной ветки>   → /root/tg-snapshot.txt
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO=zahar-pr/tg-check
LIVE=/opt/tg-panel
BASE=""
OUT=/root/tg-snapshot.txt

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?нужен коммит}"; shift ;;
    --live) LIVE="${2:?нужна папка}"; shift ;;
    --out) OUT="${2:?нужен файл}"; shift ;;
    *) echo "не знаю ключ: $1"; exit 1 ;;
  esac
  shift
done
[ -n "$BASE" ] || { echo "нужен --base <коммит, который выкладывали>"; exit 1; }
[ -f "$LIVE/router.mjs" ] || { echo "в $LIVE нет панели"; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# Чистка всего, что уходит в снимок: логины и пароли в адресах, ключи API,
# токены ботов, строки вида KEY=..., хэш api Telegram, номера телефонов (кроме
# последних 4 цифр)
scrub() {
  sed -E \
    -e 's#(://)[^/@[:space:]"'\'']+@#\1***@#g' \
    -e 's#(sk-[A-Za-z0-9]{2})[A-Za-z0-9_-]{8,}#\1***#g' \
    -e 's#[0-9]{8,10}:[A-Za-z0-9_-]{30,}#***бот-токен***#g' \
    -e 's#([A-Za-z_]*(KEY|TOKEN|SECRET|PASS|PASSWORD|HASH|AUTH)[A-Za-z_]*["'\'']?[[:space:]]*[:=][[:space:]]*["'\'']?)[^"'\''[:space:],;]{6,}#\1***#Ig' \
    -e 's#\b[0-9a-f]{32}\b#***hex32***#g' \
    -e 's#\+?7[0-9]{6}([0-9]{4})\b#+7******\1#g'
}
# Файл похож на секрет — содержимое не включаем вовсе
secretish() {
  grep -qE 'sk-[A-Za-z0-9_-]{20,}|[0-9]{8,10}:[A-Za-z0-9_-]{30,}|://[^/@[:space:]]+:[^@[:space:]]+@|api_hash|API_HASH|BEGIN [A-Z ]*PRIVATE KEY|password[[:space:]]*[=:][[:space:]]*["'\''][^"'\'']{4,}' "$1"
}
sec() { printf '\n\n======== %s ========\n' "$*"; }

say() { printf '%s\n' "$*" >&2; }
say "1/4  Скачиваю ветку ${BASE:0:7} для сравнения"
mkdir -p "$T/base"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$BASE" | tar xz -C "$T/base" --strip-components=1 \
  || { say "не скачал $BASE с GitHub"; exit 1; }

{
  sec "снимок $(date -u '+%Y-%m-%d %H:%M UTC') · база ${BASE:0:7} · $LIVE"
  echo "служба: $(systemctl is-active tg-panel 2>&1)"
  echo "node: $(node -v 2>&1)"
  echo "python: $("$LIVE/venv-tg/bin/python" -V 2>&1)"
  echo "telethon: $("$LIVE/venv-tg/bin/python" -c 'import telethon; print(telethon.__version__)' 2>&1)"
  echo "задач сейчас: $(pgrep -u tgpanel -f '[p]ython.*\.py' | wc -l)"
  echo "профили: $(ls "$LIVE/profiles" 2>/dev/null | tr '\n' ' ')"
  echo "ключ модели: $(grep -c '^LLM_API_KEY=' "$LIVE/.env" 2>/dev/null || echo 0) · модель: $(grep -h '^LLM_MODEL=' "$LIVE/.env" 2>/dev/null | cut -d= -f2-)"
  echo "ключ Asocks: $([ -s "$LIVE/asocks.json" ] && echo есть || echo НЕТ)"
} > "$T/head.txt"

say "2/4  Правки кода на сервере против ветки"
{
  sec "ПРАВКИ НА СЕРВЕРЕ против ${BASE:0:7} (diff -u ветка → сервер)"
  while IFS= read -r -d '' f; do
    f="${f#./}"
    case "$f" in message.txt|chat-priority.txt|.gitignore|tests/*) continue ;; esac
    [ -f "$LIVE/$f" ] || continue
    cmp -s "$T/base/$f" "$LIVE/$f" && continue
    if secretish "$LIVE/$f"; then echo; echo "### $f — похоже на секрет внутри, разницу не показываю"; continue; fi
    echo; echo "### $f"
    diff -u --label "ветка/$f" --label "сервер/$f" "$T/base/$f" "$LIVE/$f" | head -c 150000 || true
  done < <(cd "$T/base" && find . -type f -print0 | sort -z)
} > "$T/diff.txt"

{
  sec "НОВЫЕ ФАЙЛЫ КОДА НА СЕРВЕРЕ (их нет в ветке)"
  while IFS= read -r -d '' f; do
    f="${f#./}"
    [ -e "$T/base/$f" ] && continue
    sz=$(wc -c < "$LIVE/$f")
    if secretish "$LIVE/$f"; then echo; echo "### $f ($sz байт) — похоже на секрет внутри, не включаю"; continue; fi
    if [ "$sz" -gt 60000 ]; then echo; echo "### $f ($sz байт) — большой, только начало"; head -c 20000 "$LIVE/$f"; continue; fi
    echo; echo "### $f ($sz байт)"; cat "$LIVE/$f"
  done < <(cd "$LIVE" && find . \( -name venv -o -name venv-tg -o -name node_modules -o -name sessions \
      -o -name accounts -o -name chats -o -name enrich -o -name profiles -o -name talks -o -name personas \
      -o -name avatars -o -name uploads -o -name desktop -o -name qr -o -name tg-profile -o -name .git \
      -o -name tdata -o -name __pycache__ -o -name '_backup_*' -o -name '_reset_backup_*' \) -prune -o -type f \
      \( -name '*.py' -o -name '*.mjs' -o -name '*.js' -o -name '*.html' -o -name '*.css' -o -name '*.sh' \) \
      -print0 | sort -z)
} > "$T/new.txt"

say "3/4  Состояние профилей"
"$LIVE/venv-tg/bin/python" -I - "$LIVE" > "$T/state.txt" 2>&1 <<'PY' || true
import json, re, sys
from pathlib import Path
from collections import Counter

live = Path(sys.argv[1])
dirs = [("основной", live)] + [(p.name, p) for p in sorted((live / "profiles").glob("*")) if p.is_dir()]

def load(p, d):
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return d

def host(proxy):
    if not proxy:
        return "НЕТ"
    s = str(proxy)
    scheme = s.split("://", 1)[0] if "://" in s else "?"
    return f"{scheme}://{s.rsplit('@', 1)[-1]}" + (" (сессия)" if "-session-" in s else "")

def mask(t):
    return re.sub(r"\+?7\d{6}(\d{4})", r"+7******\1", str(t or ""))

for name, d in dirs:
    print(f"\n\n======== ПРОФИЛЬ {name} ({d}) ========")
    accs = load(d / "accounts.json", [])
    print(f"аккаунтов: {len(accs)}")
    keys = ["role", "authed", "proxyOwn", "spamKind", "retired", "reserve", "fullRestUntil", "sendHoldUntil",
            "driftCountry", "warmDay", "day"]
    for a in accs:
        extra = " ".join(f"{k}={a.get(k)}" for k in keys if a.get(k) not in (None, "", False))
        print(f"  {a.get('id')}: «{mask(a.get('title') or a.get('name'))}» прокси {host(a.get('proxy'))}"
              f" | prev {host(a.get('proxyPrev')) if a.get('proxyPrev') else '-'} | {extra}")
    e = d / "enrich"
    st = load(e / "state.json", {})
    print("обогащение, state.json:", json.dumps({k: v for k, v in st.items()}, ensure_ascii=False))
    chats = load(e / "chats.json", {})
    print("чатов:", len(chats), dict(Counter(v.get("status") for v in chats.values())))
    for k, v in list(chats.items())[:40]:
        print(f"  {v.get('status')}: {v.get('title') or v.get('ref')} · читатель {v.get('reader') or '-'}"
              f"{' · ошибка: ' + str(v.get('err'))[:120] if v.get('err') else ''}")
    kw = load(e / "keywords.json", {})
    items = kw.get("items") or []
    print(f"ключевики: {len(items)}, пройдено {sum(1 for i in items if i.get('done'))}, тема «{kw.get('topic', '')}»")
    print("   ", ", ".join(i.get("q", "") for i in items[:60]))
    leads = load(e / "leads.json", {})
    print(f"лидов: {len(leads)}, исключено {sum(1 for l in leads.values() if l.get('excluded'))}, "
          f"профиль посмотрен {sum(1 for l in leads.values() if l.get('profile_at'))}")
    ev = d / "events.jsonl"
    if ev.exists():
        print("последние события (Что происходит):")
        for ln in ev.read_text("utf-8", "replace").splitlines()[-40:]:
            print("  ", mask(ln)[:300])
PY

say "4/4  Журнал службы"
{
  sec "ЖУРНАЛ СЛУЖБЫ tg-panel (последние 400 строк)"
  journalctl -u tg-panel -n 400 --no-pager 2>&1 || true
  sec "служба: unit-файл (значения переменных скрыты)"
  systemctl cat tg-panel 2>&1 | sed -E 's#^(Environment=[^=]+=).*#\1***#' || true
  sec "crontab root"
  crontab -l 2>&1 || true
} > "$T/log.txt"

cat "$T/head.txt" "$T/state.txt" "$T/diff.txt" "$T/new.txt" "$T/log.txt" | scrub > "$OUT"
chmod 600 "$OUT"
say ""
say "готово: $OUT ($(wc -c < "$OUT") байт)"
say "проверка: похожего на секреты в снимке — $(grep -cE 'sk-[A-Za-z0-9]{20,}|://[^*/@[:space:]]+:[^@[:space:]]+@|BEGIN [A-Z ]*PRIVATE KEY' "$OUT" || true) строк (должно быть 0)"
