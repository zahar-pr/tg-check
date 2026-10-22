#!/usr/bin/env bash
#
# Слить ветку с кодом, который УЖЕ стоит на сервере, — когда владелец правил
# панель и выкладывал её со своего компьютера, а на GitHub это не отправил.
# push.sh такие правки затёр бы. Здесь основа — серверный код, а сверху
# накладываются только изменения ветки (разница от общей базы).
#
# На сервере, из распакованной ветки:
#     bash deploy/merge-here.sh        собрать и проверить; живую панель НЕ трогает
# Если в конце «всё чисто»:
#     bash /root/tg-merge/work/deploy/push.sh --here --code-only
#
#   --base <коммит>   общая база ветки и серверного кода (по умолчанию main на 19.10)
#   --live <папка>    где стоит панель (по умолчанию /opt/tg-panel)
#   --out <папка>     где собирать (по умолчанию /root/tg-merge)
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO=zahar-pr/tg-check
BASE=26df158c869c14e848d6a25d495ff5d5e77b5e92
LIVE=/opt/tg-panel
OUT=/root/tg-merge

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?нужен коммит}"; shift ;;
    --live) LIVE="${2:?нужна папка}"; shift ;;
    --out) OUT="${2:?нужна папка}"; shift ;;
    *) echo "не знаю ключ: $1"; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$SRC/router.mjs" ] || die "запускать из распакованной ветки (рядом нет router.mjs)"
[ -f "$LIVE/router.mjs" ] || die "в $LIVE нет панели"
case "$OUT" in /|"$LIVE"|"$LIVE"/*|"$SRC") die "--out не может быть $OUT" ;; esac
if ! command -v patch >/dev/null; then
  echo "  ставлю patch (маленькая системная утилита для наложения правок)"
  apt-get install -y -qq patch >/dev/null || die "не вышло поставить patch: apt-get install -y patch"
fi
PY="$LIVE/venv-tg/bin/python"
[ -x "$PY" ] || PY=python3

rm -rf "$OUT"
mkdir -p "$OUT/base" "$OUT/work"

say "1/5  Скачиваю общую базу ${BASE:0:7}"
if [ -n "${MERGE_BASE_DIR:-}" ]; then
  cp -a "$MERGE_BASE_DIR/." "$OUT/base/"                    # песочница: база уже на диске
else
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$BASE" | tar xz -C "$OUT/base" --strip-components=1 \
    || die "не скачал базу с GitHub"
fi

# Данные, которые лежат в репозитории как образец, а на сервере правятся в
# панели: их не сравниваем и не возим (push.sh их тоже не берёт). .gitignore
# панели не нужен вовсе — на сервере остаётся какой есть
is_data() { case "$1" in message.txt|chat-priority.txt|.gitignore) return 0 ;; esac; return 1; }

say "2/5  Что менялось на сервере после базы"
changed=()
while IFS= read -r -d '' f; do
  f="${f#./}"
  is_data "$f" && continue
  [ -f "$LIVE/$f" ] || continue
  cmp -s "$OUT/base/$f" "$LIVE/$f" || changed+=("$f")
done < <(cd "$OUT/base" && find . -type f -print0)
# свои новые файлы кода на сервере (данные и окружение — мимо)
extra=()
while IFS= read -r -d '' f; do
  f="${f#./}"
  [ -e "$OUT/base/$f" ] || extra+=("$f")
done < <(cd "$LIVE" && find . \( -name venv -o -name venv-tg -o -name node_modules -o -name sessions \
    -o -name accounts -o -name chats -o -name enrich -o -name profiles -o -name talks -o -name personas \
    -o -name avatars -o -name uploads -o -name desktop -o -name qr -o -name tg-profile -o -name .git \
    -o -name __pycache__ -o -name '_backup_*' -o -name '_reset_backup_*' \) -prune -o -type f \
    \( -name '*.py' -o -name '*.mjs' -o -name '*.js' -o -name '*.html' -o -name '*.css' -o -name '*.sh' \) -print0)
if [ ${#changed[@]} -eq 0 ] && [ ${#extra[@]} -eq 0 ]; then
  echo "  на сервере ровно база — правок владельца нет"
fi
for f in "${changed[@]}"; do
  plus=$(diff "$OUT/base/$f" "$LIVE/$f" | grep -c '^>' || true)
  minus=$(diff "$OUT/base/$f" "$LIVE/$f" | grep -c '^<' || true)
  echo "  правлен: $f  (+$plus −$minus строк)"
done
clash=()
for f in "${extra[@]}"; do
  if [ -e "$SRC/$f" ]; then clash+=("$f"); echo "  новый и на сервере, и в ветке: $f"
  else echo "  новый на сервере: $f (остаётся как есть)"; fi
done
[ ${#clash[@]} -eq 0 ] || die "одни и те же новые файлы у владельца и в ветке — сливать руками. На сервере ничего не менял."

# рабочая копия: база, поверх — серверные версии правленых файлов и его новые файлы
cp -a "$OUT/base/." "$OUT/work/"
for f in "${changed[@]}" "${extra[@]}"; do
  mkdir -p "$OUT/work/$(dirname "$f")"
  cp -p "$LIVE/$f" "$OUT/work/$f"
done
[ -f "$LIVE/.gitignore" ] && cp -p "$LIVE/.gitignore" "$OUT/work/.gitignore"   # чтобы выкладка его не подменила

say "3/5  Накладываю изменения ветки"
# версию кеша (?v=rN) поднимает каждый, кто правит веб, — эти строки иначе
# всегда «конфликтуют». Сводим их к базе, после наложения ставим новую общую
vers() { grep -ho '?v=r[0-9]*' "$@" 2>/dev/null | sed 's/?v=r//' | sort -un || true; }
for f in "$OUT"/work/web/*.html; do
  b="$(vers "$OUT/base/${f#"$OUT/work/"}")"
  [ -n "$b" ] && [ "$(printf '%s\n' "$b" | wc -l)" = 1 ] && sed -i -E "s/\?v=r[0-9]+/?v=r$b/g" "$f"
done
ln -s "$SRC" "$OUT/new"
(cd "$OUT" && diff -ruN -x .gitignore -x message.txt -x chat-priority.txt base new > branch.patch) \
  || [ $? -eq 1 ] || die "не собрал разницу ветки"
rm "$OUT/new"
echo "  файлов в правке ветки: $(grep -c '^diff ' "$OUT/branch.patch" || true)"
if ! patch -p1 -d "$OUT/work" --dry-run < "$OUT/branch.patch" > "$OUT/dry.txt" 2>&1; then
  # dry-run пишет «checking file X», потом по куску «Hunk #N FAILED at L»
  awk '/^(checking|patching) file /{f=$3} /Hunk .*FAILED|can.t find/{n[f]++} END{for (k in n) printf "  не легло в %s: кусков %d\n", k, n[k]}' \
    "$OUT/dry.txt"
  die "правки ветки не ложатся на серверный код без ручного слияния (выше — где). На сервере ничего не менял."
fi
grep -B1 'fuzz' "$OUT/dry.txt" | grep -v '^--$' | sed 's/^/  неточно: /' || true
patch -p1 -d "$OUT/work" -s --no-backup-if-mismatch < "$OUT/branch.patch"
top=$(( $(vers "$LIVE"/web/*.html "$SRC"/web/*.html | tail -1) + 1 ))
sed -i -E "s/\?v=r[0-9]+/?v=r$top/g" "$OUT"/work/web/*.html
echo "  правки легли, версия кеша страниц — r$top"

say "4/5  Проверяю собранный код"
bad=0
for f in "$OUT"/work/*.mjs "$OUT"/work/server/*.mjs "$OUT"/work/web/*.js; do
  [ -f "$f" ] || continue
  node --check "$f" 2>"$OUT/check.txt" || { echo "  ошибка в ${f#$OUT/work/}: $(head -3 "$OUT/check.txt")"; bad=1; }
done
for f in "$OUT"/work/*.py; do
  "$PY" -m py_compile "$f" 2>"$OUT/check.txt" || { echo "  ошибка в ${f#$OUT/work/}: $(tail -2 "$OUT/check.txt")"; bad=1; }
done
[ "$bad" = 0 ] || die "в собранном коде ошибки — на сервер не ставим. На сервере ничего не менял."
echo "  синтаксис: чисто"
# песочные проверки обогащения — во временных папках, живые данные не трогают
r1=$(cd "$OUT/work" && "$PY" tests/sandbox/enrich_test.py 2>&1 | tail -1) || true
r2=$(cd "$OUT/work" && PATH="$(dirname "$PY"):$PATH" node tests/sandbox/enrich_sched_test.mjs 2>&1 | tail -1) || true
echo "  тесты обогащения: $r1 / $r2"
case "$r1$r2" in *ПРОВАЛ*|*Error*|*Traceback*) bad=1 ;; esac
[ "$r1" = "ВСЁ ХОРОШО" ] && [ "$r2" = "ВСЁ ХОРОШО" ] || bad=1
# панель из собранного кода поднимается на пустой папке и не падает
T="$(mktemp -d)"
set +e
(cd "$OUT/work" && TG_PANEL_DIR="$T" node set-password.mjs check "check-$RANDOM-$RANDOM" >/dev/null \
  && TG_PANEL_DIR="$T" timeout 8 node admin.mjs --port 8899 --no-open > "$OUT/boot.txt" 2>&1)
rc=$?
set -e
rm -rf "$T"
if [ "$rc" = 124 ]; then echo "  панель запускается: да"
else echo "  панель упала при запуске (код $rc):"; tail -5 "$OUT/boot.txt"; bad=1; fi
[ "$bad" = 0 ] || die "проверки не прошли — на сервер не ставим. На сервере ничего не менял."

say "5/5  Всё чисто"
# правки владельца — архивом: их стоит отправить на GitHub, чтобы ветка их знала
if [ ${#changed[@]} -gt 0 ] || [ ${#extra[@]} -gt 0 ]; then
  tar czf "$OUT/owner-changes.tgz" -C "$LIVE" "${changed[@]}" "${extra[@]}"
  echo "  правки владельца сохранены: $OUT/owner-changes.tgz"
fi
cat <<TXT

  Собрано в $OUT/work: серверный код + обогащение. Живая панель пока старая.
  Поставить (дождётся паузы в задачах, данные не трогает):

      bash $OUT/work/deploy/push.sh --here --code-only

TXT
