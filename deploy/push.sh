#!/usr/bin/env bash
#
# Заливка панели на сервер и установка там — с этого компьютера, одной командой.
#
#     bash deploy/push.sh root@1.2.3.4
#     bash deploy/push.sh panel@example.com --key ~/.ssh/id_ed25519 --port 2222 --voice
#     bash deploy/push.sh --dry-run        собрать архив и проверить состав, никуда не ходя
#
# Что уезжает: код панели. Что НЕ уезжает никогда: сессии Telegram, реестр
# аккаунтов, пароль от панели, базы и результаты. Это же правило делает
# безопасным повторный запуск — обновление кода не затирает данные на сервере.
#
#   --key <файл>    ключ SSH (иначе — как настроено в ~/.ssh/config)
#   --port <порт>   порт SSH (по умолчанию 22)
#   --dir <путь>    куда ставить на сервере (по умолчанию /opt/tg-panel)
#   --tdata         доставить opentele/PyQt5 (импорт TDATA)
#   --voice         доставить ffmpeg (голосовые)
#   --no-password   не спрашивать вход в панель — его задаст хозяин сам
#   --code-only     только обновить код и перезапустить службу, без установки
#   --dry-run       только собрать архив и проверить, что в него не попали данные
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=""
PORT=22
KEY=""
REMOTE=/opt/tg-panel
FLAGS=""
CODE_ONLY=0
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:?нужен путь к ключу}"; shift ;;
    --port) PORT="${2:?нужен порт}"; shift ;;
    --dir) REMOTE="${2:?нужен путь}"; shift ;;
    --tdata|--voice|--no-password) FLAGS="$FLAGS $1" ;;
    --code-only) CODE_ONLY=1 ;;
    --dry-run) DRY=1 ;;
    -*) echo "не знаю ключ: $1"; exit 1 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$TARGET" ] || [ "$DRY" = 1 ] || die "куда ставим? bash deploy/push.sh root@адрес-сервера"
[ -f "$DIR/router.mjs" ] || die "запускать из папки панели"

SSH=(ssh -p "$PORT" -o ConnectTimeout=15)
[ -n "$KEY" ] && SSH+=(-i "$KEY")

# tar на macOS иначе тащит служебные метки Apple, а tar на сервере ругается
# на них десятком строк за файл — в выводе тонет всё остальное
TAR_EXTRA=()
tar --no-mac-metadata --version >/dev/null 2>&1 && TAR_EXTRA+=(--no-mac-metadata)
tar --no-xattrs --version >/dev/null 2>&1 && TAR_EXTRA+=(--no-xattrs)

# ─────────────────────────────────────────────────────────────────────────────
# Что не возим: секреты, тяжёлое и ДАННЫЕ. Данные на сервере — его собственные,
# и повторный запуск их не трогает.
#
# Список поддерживается руками, а забытая строка стоит дорого: 16.10 из-за неё
# уехал events.jsonl (он есть локально, потому что панель его тут создавала) и
# обнулил на сервере ленту «Что происходит», хотя файл лежал в .gitignore.
# .gitignore тут не защищает: tar пакует рабочую папку, а не индекс git.
#
# Поэтому рядом лежит DATA_GUARD — перечень данных, которых в архиве быть не
# должно, — и pack() сверяет с ним СОСТАВ СОБРАННОГО АРХИВА. Забыли исключение —
# выкладка остановится до соединения с сервером, а не затрёт прод молча.
#
# Тексты писем, список прогрева и очередь чатов тоже остаются на сервере: их
# правят прямо в панели, и обновление кода не должно откатывать эту правку.
# С кодом едет только образец warm-list.default.json — рабочий список панель
# заведёт из него сама, если его ещё нет.
# ─────────────────────────────────────────────────────────────────────────────
EXCLUDES=(
  './venv' './venv-tg' './node_modules' './.git' './.claude' './__pycache__' '*.pyc' './tests'
  './sessions' './accounts' './desktop' './qr' './uploads' './tg-profile'
  './accounts.json' './auth.json' './claims.json' './claims.lock' './cloud.json'
  './numbers.csv' './results.csv' './drafts.csv' './members.csv'
  './chats.json' './base.json' './replies.json' './stats-cache.json'
  './voice.ogg' './voice.json' './followup.csv' './warmup.csv' './warmup.json'
  './message-parts.json' './message.txt' './message2.txt' './message-chat.txt'
  './message-chat-plain.txt' './queue-first.txt'
  './warm-list.json' './chat-priority.txt'
  './leads.json' './leads-log.csv' './leads-tpl.txt' './lead-chats.txt' './leads-sheet.txt'
  './mirror.json' './mirror-names.txt'
  './profiles.json' './router.json' './profiles'
  './talks' './chats' './extras.csv'
  '*.csv.lock' './chats.json.lock' '*.json.tmp' '*.csv.tmp'
  './events.jsonl' './auto-run.json' './auto-run.paused-*.json' './auto-last.json' './base-set.json'
  './followup-runs.json' './followup-texts.json' './sent-ids.csv' './traffic.csv'
  './egrul.csv' './egrul-run.json' './egrul-*.log' './messages.csv' './chat-list.txt'
  './avatars' '.env' './.env'
  './asocks.json' './asocks-usage.jsonl' './asocks-ports.json' './asocks-sessions.json'
  './comments.csv' './comment-leads.csv' './comment-plan.json*' './comments-pending.json*' './comments-decisions.json*'
  './comment-persona.txt' './llm-usage.json'
  './tgapi.json' './personas'
  './enrich'
  '*.xlsx' '*.session' './_backup_*' './_reset_backup_*' '.DS_Store' '.send-gap.*'
)

# Имена файлов, которых в архиве быть не должно. Совпадает с EXCLUDES по смыслу,
# но перечислено отдельно и по basename: проверка идёт по составу архива.
DATA_GUARD=(
  accounts.json auth.json claims.json claims.lock cloud.json
  numbers.csv results.csv drafts.csv members.csv chats.json base.json replies.json
  stats-cache.json voice.ogg voice.json followup.csv warmup.csv warmup.json
  message-parts.json message.txt message2.txt message-chat.txt message-chat-plain.txt queue-first.txt
  warm-list.json chat-priority.txt
  leads.json leads-log.csv leads-tpl.txt lead-chats.txt leads-sheet.txt
  mirror.json mirror-names.txt profiles.json router.json
  events.jsonl auto-run.json auto-last.json base-set.json
  followup-runs.json followup-texts.json sent-ids.csv traffic.csv
  egrul.csv egrul-run.json messages.csv chat-list.txt extras.csv .env
  asocks.json asocks-usage.jsonl asocks-ports.json asocks-sessions.json
  comments.csv comment-leads.csv 'comment-plan.json*' 'comments-pending.json*' 'comments-decisions.json*' comment-persona.txt llm-usage.json
  tgapi.json personas
  'auto-run.paused-*.json' 'egrul-*.log'
  keywords.json joins.json add-list.txt '*.jsonl'
)

TMP_ARCHIVE=""
pack() {
  TMP_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/tg-check-push.XXXXXX")" || die "не смог создать временный файл"
  trap 'rm -f "$TMP_ARCHIVE"' EXIT
  local ex=() e
  for e in "${EXCLUDES[@]}"; do ex+=(--exclude="$e"); done
  tar -C "$DIR" "${TAR_EXTRA[@]}" "${ex[@]}" -czf "$TMP_ARCHIVE" . || die "не смог собрать архив"

  # Сверка состава: что реально лежит в архиве против DATA_GUARD
  local bad="" m base pat n=0
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    m="${m#./}"
    if [ "${m%/}" != "$m" ]; then continue; fi      # каталог
    n=$((n + 1))
    base="${m##*/}"
    for pat in "${DATA_GUARD[@]}"; do
      # shellcheck disable=SC2254
      case "$base" in $pat) bad="$bad $m"; break ;; esac
    done
  done < <(tar tzf "$TMP_ARCHIVE")

  if [ -n "$bad" ]; then
    die "в архив попали данные:$bad

  Это файлы сервера, а не код: выкладка их затрёт. Добавь исключение в EXCLUDES
  (deploy/push.sh) и, если файл новый, строку в DATA_GUARD — и запусти снова.
  На сервер ничего не ушло."
  fi
  echo "  в архиве файлов: $n, данных среди них нет"
}

# Архив собираем и проверяем ДО соединения с сервером: забытое исключение
# останавливает выкладку раньше, чем на сервере что-то изменится.
say "1/3  Собираю архив и проверяю состав"
pack
if [ "$DRY" = 1 ]; then
  say "готово (--dry-run): архив собран и проверен, на сервер ничего не ушло"
  exit 0
fi

say "2/3  Проверяю связь с $TARGET и копирую код в $REMOTE"
# Пароль по SSH запрещаем явно: ему не место ни в скрипте, ни в переписке.
# А вот «сервер видим впервые, принять его ключ?» спросить можно — на новом
# сервере это первое, что спрашивает ssh, и молча падать тут незачем.
if ! "${SSH[@]}" -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
     "$TARGET" true; then
  die "не пускает по ключу.
Вход по паролю тут не годится — пароли не место в скриптах и переписке.
Заведи ключ и положи его на сервер:
    ssh-keygen -t ed25519            (если ключа ещё нет)
    ssh-copy-id -p $PORT $TARGET     (спросит пароль сервера один раз)
и запусти push.sh снова."
fi
USER_REMOTE="$("${SSH[@]}" "$TARGET" 'id -un')"
echo "  вошли как $USER_REMOTE"

# Готовим место. Под root заводим отдельного пользователя: службе ни к чему
# права, которых она не использует.
OWNER_REMOTE="$("${SSH[@]}" "$TARGET" '
  if [ "$(id -u)" = 0 ]; then
    id tgpanel >/dev/null 2>&1 || useradd -m -s /bin/bash tgpanel
    echo tgpanel
  else
    id -un
  fi')"
[ -n "$OWNER_REMOTE" ] || die "не смог завести пользователя на сервере"
"${SSH[@]}" "$TARGET" "\$( [ \"\$(id -u)\" = 0 ] || echo sudo ) mkdir -p '$REMOTE'"
echo "  папка готова, владелец $OWNER_REMOTE"

"${SSH[@]}" "$TARGET" "tar xzf - --no-same-owner -C '$REMOTE'" < "$TMP_ARCHIVE"
# tar под root восстановил бы владельца из архива — то есть номер пользователя
# с ЭТОГО компьютера, которого на сервере нет. Поэтому и --no-same-owner,
# и явный chown: иначе установка спотыкается о владельца «UNKNOWN».
"${SSH[@]}" "$TARGET" "\$( [ \"\$(id -u)\" = 0 ] || echo sudo ) chown -R '$OWNER_REMOTE' '$REMOTE'"
# Папку закрываем от посторонних: внутри сессии Telegram и реестр аккаунтов.
# Это же разделяет профили — соседняя панель работает от другого пользователя
# и в эту папку не заглянет.
"${SSH[@]}" "$TARGET" "\$( [ \"\$(id -u)\" = 0 ] || echo sudo ) chmod 700 '$REMOTE'"
echo "  код на месте"

if [ "$CODE_ONLY" = 1 ]; then
  say "3/3  Перезапускаю службу"
  "${SSH[@]}" "$TARGET" "\$( [ \"\$(id -u)\" = 0 ] || echo sudo ) systemctl restart tg-panel && \
    \$( [ \"\$(id -u)\" = 0 ] || echo sudo ) systemctl is-active tg-panel"
  echo "  готово — данные на сервере не тронуты"
  exit 0
fi

say "3/3  Ставлю панель на сервере"
case "$FLAGS" in
  *--no-password*) echo "  Пароль от панели не спрашиваю — задашь его сам, команда будет ниже." ;;
  *) echo "  Сейчас сервер спросит логин и пароль для входа в панель — набирай их"
     echo "  здесь, они никуда больше не уходят." ;;
esac
"${SSH[@]}" -t "$TARGET" "cd '$REMOTE' && \$( [ \"\$(id -u)\" = 0 ] || echo sudo ) bash deploy/install.sh$FLAGS"

cat <<TXT

  Панель стоит на сервере и слушает 127.0.0.1:8787 — снаружи её пока не видно.
  Открыть доступ (на сервере):

      cloudflared tunnel --url http://localhost:8787

  Обновить код потом:  bash deploy/push.sh $TARGET --code-only

TXT
