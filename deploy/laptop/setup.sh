#!/usr/bin/env bash
#
# Один раз на ноутбуке: рабочая папка с кодом сервера, синхронизация и агент.
#
#     curl -fsSL https://raw.githubusercontent.com/zahar-pr/tg-check/<коммит>/deploy/laptop/setup.sh | bash -s -- <коммит>
#
# Что делает:
#   1. запись tg-server в ~/.ssh/config (root@46.16.15.238, ключ ~/.ssh/id_ed25519)
#      и проверка, что сервер пускает по ключу;
#   2. ~/tg-panel — код с сервера (без данных и секретов) + ./tg и правила
#      для агента (CLAUDE.md);
#   3. агент ./ai на Claude Agent SDK в ~/.tg-agent (ключ спросит при первом запуске).
#
set -euo pipefail
REF="${1:-web-refactor}"
TARGET="${TG_DIR:-$HOME/tg-panel}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

for c in git ssh tar curl; do command -v "$c" >/dev/null || die "нужен $c: sudo apt install $c"; done

say "1/3  Сервер"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ "$(ssh -G tg-server 2>/dev/null | awk '$1 == "hostname" {print $2}')" != "46.16.15.238" ]; then
  [ -f "$HOME/.ssh/id_ed25519" ] || die "нет ключа ~/.ssh/id_ed25519 — тот, с которым ты заходишь на сервер"
  cat >> "$HOME/.ssh/config" <<'CFG'

Host tg-server
  HostName 46.16.15.238
  User root
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
CFG
  chmod 600 "$HOME/.ssh/config"
  echo "  в ~/.ssh/config добавлен tg-server"
fi
if ! out="$(ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new tg-server true 2>&1)"; then
  printf '%s\n' "$out" | tail -3 | sed 's/^/  /'
  case "$out" in
    *kex_exchange_identification*|*"closed by remote host"*|*"Connection reset"*)
      die "сервер обрывает соединение ещё до проверки ключа. Так бывает, когда sshd
  оштрафовал адрес за неудачные входы (OpenSSH 9.8+) или адрес в блоке — часто это
  адрес VPN. Узнай свой адрес: curl -s https://ifconfig.me ; и разреши его на сервере
  (в Термиусе) — команда в переписке с Claude. Потом запусти эту установку снова." ;;
    *"Permission denied"*)
      die "сервер не принял ключ ~/.ssh/id_ed25519 — его открытой части нет в /root/.ssh/authorized_keys" ;;
    *) die "не подключился к серверу. Проверь: ssh root@46.16.15.238 hostname" ;;
  esac
fi
echo "  пускает по ключу"

say "2/3  Рабочая папка $TARGET"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://codeload.github.com/zahar-pr/tg-check/tar.gz/$REF" | tar xz -C "$TMP" --strip-components=1 \
  || die "не скачал инструменты ($REF)"
bash "$TMP/deploy/laptop/tg" init "$TARGET" "$TMP"

say "3/3  Агент"
(cd "$TARGET" && ./tg agent) || echo "  агент не встал — повтори потом: cd $TARGET && ./tg agent"

cat <<TXT

Всё. Дальше:
    cd $TARGET
    ./ai          агент на кредиты Console (спросит API-ключ один раз)
TXT
