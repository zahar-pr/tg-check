/**
 * Реестр подключённых аккаунтов Telegram.
 *
 * Каждый аккаунт — это своя папка профиля Chromium (в ней лежит сессия).
 * Профиль занимает ровно один процесс, поэтому панель запускает задачи
 * по одной: два прогона одновременно подрались бы за профиль.
 *
 * accounts.json:
 *   [{ id, title, dir, added }]
 *
 * Старая одноаккаунтная папка ./tg-profile подхватывается как первый
 * аккаунт — ничего не переносим, живая сессия остаётся на месте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Папка данных профиля (реестр аккаунтов и сессии): её задаёт панель через TG_PANEL_DIR,
// иначе — там же, где код.
export const DIR = process.env.TG_PANEL_DIR
  ? path.resolve(process.env.TG_PANEL_DIR)
  : path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'accounts.json');
const LEGACY = 'tg-profile';

const read = () => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
};

// Замок на accounts.json, общий с Python-задачами (tglib.py): простой lock-файл
// через O_EXCL — его умеют оба языка, в отличие от flock. Нужен, потому что с
// параллелью (6 задач) и сторожем файл правят сразу несколько процессов: без
// замка «прочитал-изменил-записал» теряет чужую правку (напр. вердикт spamOk).
const LOCK = FILE + '.lock';
function withLock(fn) {
  let fd = null;
  const t0 = Date.now();
  while (fd === null) {
    try { fd = fs.openSync(LOCK, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // краш с незакрытым замком не должен вешать всё: старше 10 с — крадём
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10_000) { fs.unlinkSync(LOCK); continue; } } catch {}
      if (Date.now() - t0 > 5_000) { fd = -1; break; }   // не дождались — пишем без замка, чем копим
      const until = Date.now() + 40; while (Date.now() < until) { /* короткий спин */ }
    }
  }
  try { if (fd !== null && fd >= 0) fs.writeSync(fd, String(process.pid)); } catch {}
  try { return fn(); }
  finally { if (fd !== null && fd >= 0) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(LOCK); } catch {} } }
}

// Атомарная запись: сначала во временный файл, потом rename поверх — читатель
// (панель или задача) никогда не получит обрезанный файл и пустой список.
function writeAtomic(list) {
  const tmp = FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

export const save = (list) => writeAtomic(list);

/** Прочитать-изменить-записать под общим замком: fn(list) правит список на месте. */
function mutate(fn) {
  return withLock(() => { const l = read(); const r = fn(l); writeAtomic(l); return r; });
}

/** Список аккаунтов. Первый вызов заводит реестр из старой папки профиля. */
export function list() {
  let l = read();
  if (!l.length && fs.existsSync(path.join(DIR, LEGACY))) {
    l = [{ id: 'a1', title: 'Аккаунт 1', dir: LEGACY, added: new Date().toISOString() }];
  }
  // у записей до появления отметки её нет вовсе — тогда (и только тогда)
  // судим по папке профиля: она заведена настоящим входом
  let touched = false;
  for (const a of l) {
    if (a.authed === undefined) {
      a.authed = fs.existsSync(path.join(DIR, a.dir, 'Default'));
      touched = true;
    }
  }
  if (touched) save(l);
  return l;
}

export const profilePath = (acc) => path.join(DIR, acc.dir);

/**
 * Файл сессии Telethon — то, чем аккаунт работает сейчас. Путь тот же, что
 * считает tglib.py: своё поле в реестре важнее умолчания sessions/<id>.session.
 */
export const sessionPath = (acc) =>
  acc.session ? (path.isAbsolute(acc.session) ? acc.session : path.join(DIR, acc.session))
              : path.join(DIR, 'sessions', `${acc.id}.session`);

export const hasSession = (acc) => fs.existsSync(sessionPath(acc));

/**
 * Вошли или нет. Отметку ставит login.mjs после реального входа: по папке
 * профиля судить нельзя — Chromium заводит её и на пустом окне с QR.
 */
export const isAuthed = (acc) => acc.authed === true;

/** Правит поля записи аккаунта, не трогая остальные — как set_field в tglib.py. */
export function setField(id, fields) {
  return mutate((l) => {
    const a = l.find((x) => x.id === id);
    if (!a) return false;
    Object.assign(a, fields);
    return true;
  });
}

export function setAuthed(id, value) {
  return mutate((l) => {
    const acc = l.find((a) => a.id === id);
    if (!acc) return false;
    acc.authed = !!value;
    return true;
  });
}

/**
 * Участвует ли аккаунт в рассылке. Новые заводятся только на прогрев и в
 * рассылку переводятся руками, когда созреют. У старых записей роли нет —
 * они работали в рассылке и до разделения, так и остаётся.
 */
const untilLeft = (acc, key) => {
  const t = Date.parse(acc?.[key] || '');
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
};

/**
 * После заморозки — два вида отдыха (оба ставятся руками, ISO-время):
 *   fullRestUntil — ПОЛНЫЙ: к Telegram не подключается вовсе;
 *   sendHoldUntil — «без рассылки»: людям не пишет, а прогрев идёт
 *                   (реакции, каналы, переписка со своими).
 * Роль можно переключить одним «ОК» при запуске прогона — отметку так не снимешь.
 * Возвращают, сколько мс ещё осталось, 0 — можно.
 */
export const fullRestLeft = (acc) => untilLeft(acc, 'fullRestUntil');
export const sendHoldLeft = (acc) => Math.max(untilLeft(acc, 'sendHoldUntil'), fullRestLeft(acc));

/** Читатель (обогащение): только читает чаты — не греется и людям не пишет. */
export const isReader = (acc) => acc?.role === 'read';

export const inOutreach = (acc) => acc.role !== 'warm' && !isReader(acc) && !sendHoldLeft(acc);

/** id -> аккаунт. Без id берём первый: так старые запуски из терминала работают как раньше. */
export function resolve(id) {
  const l = list();
  if (!l.length) throw new Error('нет ни одного аккаунта — заведи его в панели (шаг 1)');
  const acc = id ? l.find((a) => a.id === id) : l[0];
  if (!acc) throw new Error(`аккаунт «${id}» не найден`);
  return acc;
}

export function add(title) {
  return mutate((l) => {
    const n = Math.max(0, ...l.map((a) => +(String(a.id).match(/\d+$/)?.[0] || 0))) + 1;
    const acc = { id: `a${n}`, title: (title || '').trim() || `Аккаунт ${n}`,
                  dir: path.join('accounts', `a${n}`), added: new Date().toISOString(),
                  role: 'warm' };
    fs.mkdirSync(profilePath(acc), { recursive: true });
    l.push(acc);
    return acc;
  });
}

/**
 * Строка прокси -> вид, который понимает Playwright.
 * Терпим все ходовые записи, включая host:port:user:pass — так их обычно продают.
 *   http://user:pass@1.2.3.4:8000
 *   socks5://1.2.3.4:1080
 *   1.2.3.4:8000
 *   1.2.3.4:8000:user:pass
 * Пустая строка = без прокси, аккаунт ходит с вашего адреса.
 */
export function parseProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let scheme = 'http', rest = s;
  const m = s.match(/^([a-z0-9]+):\/\/(.*)$/i);
  if (m) { scheme = m[1].toLowerCase(); rest = m[2]; }
  let user = '', pass = '';
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const cred = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const i = cred.indexOf(':');
    user = i === -1 ? cred : cred.slice(0, i);
    pass = i === -1 ? '' : cred.slice(i + 1);
  }
  const parts = rest.split(':');
  if (parts.length === 4) { user = parts[2]; pass = parts[3]; }
  else if (parts.length !== 2) throw new Error(`не разобрал прокси «${s}» — нужно host:port`);
  const [host, port] = parts;
  if (!host || !/^\d{1,5}$/.test(port)) throw new Error(`не разобрал прокси «${s}» — нужно host:port`);
  return { server: `${scheme}://${host}:${port}`, ...(user ? { username: user, password: pass } : {}) };
}

/** Как показать прокси человеку: без пароля. */
export function proxyLabel(raw) {
  try {
    const p = parseProxy(raw);
    return p ? `${p.server}${p.username ? ` (${p.username}:***)` : ''}` : 'прямой IP';
  } catch { return 'прокси задан с ошибкой'; }
}

/** Оставлено для совместимости с панелью: предупреждать больше не о чем. */
export function proxyWarning() {
  return '';
}

/** Опции запуска браузера для аккаунта: прокси, если он у аккаунта свой. */
export function launchOptions(acc) {
  const p = acc.proxy ? parseProxy(acc.proxy) : null;
  return p ? { proxy: p } : {};
}

/**
 * Прокси для запуска Chromium с учётом его ограничений.
 *
 * SOCKS5 с логином и паролем Chromium не умеет — для такого поднимаем
 * локальный мост (socks-bridge.mjs) и отдаём его адрес. Всё остальное
 * (http, socks5 без пароля, прямой IP) уходит как есть.
 *
 * Возвращает { proxy, close }: proxy кладётся в опции запуска, close()
 * гасит мост — звать обязательно после закрытия браузера.
 */
export async function openProxy(acc) {
  if (!acc.proxy) return { proxy: undefined, close: () => {} };
  const p = parseProxy(acc.proxy);
  if (/^socks/i.test(p.server) && p.username) {
    const { startBridge } = await import('./socks-bridge.mjs');
    const bridge = await startBridge(p);
    return { proxy: { server: bridge.url }, close: () => bridge.close() };
  }
  return { proxy: p, close: () => {} };
}

export function setProxy(id, raw) {
  parseProxy(raw);                 // проверяем до замка: кривую строку не сохраняем
  return mutate((l) => {
    const acc = l.find((a) => a.id === id);
    if (!acc) return false;
    acc.proxy = String(raw || '').trim();
    return true;
  });
}

export function rename(id, title) {
  // имя приходит из браузера и может оказаться мусором — такое не принимаем,
  // иначе аккаунт в панели называется «undefined»
  const t = String(title ?? '').trim();
  if (!t || /^(undefined|null|nan)$/i.test(t)) return false;
  return mutate((l) => {
    const acc = l.find((a) => a.id === id);
    if (!acc) return false;
    acc.title = t;
    return true;
  });
}

/** Убирает аккаунт вместе с профилем: сессия на этом компьютере пропадает. */
export function remove(id) {
  return mutate((l) => {
    const acc = l.find((a) => a.id === id);
    if (!acc) return false;
    fs.rmSync(profilePath(acc), { recursive: true, force: true });
    // сессия Telethon живёт отдельным файлом — её тоже убираем, иначе
    // «отключённый» аккаунт остаётся рабочим ключом на диске
    fs.rmSync(sessionPath(acc), { force: true });
    fs.rmSync(path.join(DIR, 'qr', `${acc.id}.svg`), { force: true });
    l.splice(0, l.length, ...l.filter((a) => a.id !== id));
    return true;
  });
}

/** --account из аргументов запуска. */
export function argAccount(argv = process.argv) {
  const i = argv.indexOf('--account');
  return i === -1 ? '' : argv[i + 1];
}

/**
 * Лог черновиков раньше был phone,ok,at — без аккаунта и без отметки отправки.
 * Дописываем недостающие колонки, приписывая старые строки первому аккаунту:
 * тогда и панель, и скрипт читают один формат.
 */
export function migrateDraftsLog() {
  const LOG = path.join(DIR, 'drafts.csv');
  const HEAD = 'phone,account,ok,sent,at\n';
  if (!fs.existsSync(LOG)) { fs.writeFileSync(LOG, HEAD); return 0; }
  const raw = fs.readFileSync(LOG, 'utf8');
  const [head, ...lines] = raw.trim().split('\n');
  // переводим ТОЛЬКО ровно старую шапку: прогон миграции по уже новому файлу
  // сдвинул бы колонки и стёр отметки времени
  if (head.trim() !== 'phone,ok,at') return 0;
  const cols = head.split(',');
  const first = list()[0]?.id || '';
  const out = lines.filter(Boolean).map((l) => {
    const v = l.split(',');
    const r = Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
    return `${r.phone},${first},${r.ok || ''},,${r.at || ''}`;
  });
  fs.writeFileSync(LOG, HEAD + out.join('\n') + (out.length ? '\n' : ''));
  return out.length;
}
