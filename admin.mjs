/**
 * Пульт: веб-обёртка над теми же скриптами, что запускаются из терминала.
 *
 * Панель НЕ открывает Telegram сама и не держит браузер — она запускает
 * дочерним процессом уже существующие скрипты и показывает их вывод живьём.
 *
 * Аккаунты работают ПАРАЛЛЕЛЬНО: у каждого свой профиль, свой процесс и,
 * если задан, свой прокси. Один аккаунт — одна задача за раз (профиль
 * Telegram занимает ровно один процесс). Чтобы двое не прошли по одним и
 * тем же номерам, база делится бронями (claims.mjs).
 *
 * Вход в панель — по логину и паролю:  node set-password.mjs <логин> <пароль>
 *
 *   node admin.mjs                        -> http://localhost:8787
 *   node admin.mjs --host 0.0.0.0 --cert cert.pem --key key.pem
 */

/*
 * КАРТА ФАЙЛА — он большой, и листать его вслепую незачем.
 *
 *    157  РЕЕСТР ЗАДАЧ — какой скрипт за что отвечает
 *    326  ЗАПУСК ЗАДАЧ — порождение процесса и разбор его вывода
 *    731  ПРОГРЕВ — что показываем в панели
 *   1691  ФАЙЛЫ И ВНЕШНИЕ ПРОГРАММЫ — python, ffmpeg, база, голосовое
 *   1881  HTTP — статика, вход, маршруты API
 *     1957  АККАУНТЫ — список, заведение, профиль, прокси, Desktop
 *     2365  БАЗА ПОЛУЧАТЕЛЕЙ — набор, загрузка, участники чатов
 *     2504  ТЕКСТЫ ПИСЕМ И ГОЛОСОВОЕ
 *     2633  СОСТОЯНИЕ ПАНЕЛИ — счётчики, журнал, лента, результаты
 *     2877  ПРОКСИ, ЗЕРКАЛА И ЛИМИТЫ
 *     3003  ПРОГРЕВ И АВТОПРОГОН — включение и настройки
 *     3039  РУЧНОЙ ЗАПУСК И ОСТАНОВКА ЗАДАЧ
 *
 * Правило чтения: всё, что выше раздела HTTP, — «как панель работает»,
 * всё, что ниже, — «что она отвечает браузеру».
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as accounts from './accounts.mjs';
import * as claims from './claims.mjs';
import * as auth from './auth.mjs';
import { makeReadCsv } from './server/csv.mjs';
import { makeStats } from './server/stats.mjs';
import { makeWarmup, restEnd } from './server/warmup.mjs';
import { makeEvents } from './server/events.mjs';
import { makeResults } from './server/results.mjs';
import { makeProxyGuard } from './server/proxyguard.mjs';
import * as desktop from './server/desktop.mjs';
import { buildKit, buildPult, kitProxy } from './server/kit.mjs';
import { makeAsocks, ASOCKS_EVERY } from './server/asocks.mjs';
import { makeOwnProxy, ASOCKS_GATEWAY, OWN_COUNTRY } from './server/ownproxy.mjs';
import { makeLlmUsage, LLM_EVERY } from './server/llmusage.mjs';
import { makeEnrich } from './server/enrich.mjs';
import * as vercel from './server/vercel.mjs';

// Код один на всех, данные у каждого профиля свои.
//   CODE — где лежит сама панель: задачи на Python, venv, web, kit.
//   DIR  — папка данных профиля: реестр аккаунтов, сессии, база, результаты.
// Без TG_PANEL_DIR панель работает по-старому: данные там же, где код.
const CODE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.TG_PANEL_DIR ? path.resolve(process.env.TG_PANEL_DIR) : CODE;
fs.mkdirSync(DIR, { recursive: true });

// Ключ привратника: есть — значит панель работает профилем внутри общей
// панели, и запросы с этим ключом считаются вошедшими.
const INNER = process.env.TG_PANEL_TOKEN || '';
const innerOk = (given) => {
  if (!INNER || typeof given !== 'string' || given.length !== INNER.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(INNER));
};
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

// Модули собираем здесь: им нужны папка панели и чтение CSV, а решать, где
// что лежит, — дело точки входа, а не самих модулей.
const readRaw = makeReadCsv(DIR);

/**
 * Два независимых набора получателей: «по номерам» (база из xlsx, файлы в
 * корне) и «по чатам» (люди из разбора чатов, папка chats/). Раньше они
 * лежали вместе, и рассылка по базе клиентов заодно писала тысячам людей из
 * чатов. Проверка, очередь и счётчики видят только выбранный набор.
 * История отправок при этом общая там, где речь об аккаунте, а не о базе:
 * дневной лимит, второе письмо и счётчик зеркал считают оба набора.
 */
const SET_FILES = new Set(['numbers.csv', 'results.csv', 'drafts.csv']);
const BASE_SET_FILE = path.join(DIR, 'base-set.json');
let baseSet = 'phones';
try { if (JSON.parse(fs.readFileSync(BASE_SET_FILE, 'utf8')).set === 'chats') baseSet = 'chats'; } catch {}
const SETS = ['phones', 'chats'];
const setWord = (set) => (set === 'chats' ? 'по чатам' : 'по номерам');
const setPath = (name, set = baseSet) => (set === 'chats' && SET_FILES.has(name) ? path.join('chats', name) : name);
const readCsv = (name, set) => readRaw(setPath(name, set));
const readAll = (name) => (SET_FILES.has(name)
  ? [...readRaw(name), ...readRaw(path.join('chats', name))] : readRaw(name));
function setBaseSet(set) {
  baseSet = set === 'chats' ? 'chats' : 'phones';
  fs.mkdirSync(path.join(DIR, 'chats'), { recursive: true });
  fs.writeFileSync(BASE_SET_FILE, JSON.stringify({ set: baseSet }) + '\n');
}

// часовой пояс базы: по нему рабочее время рассылки и время в ленте событий
const WORK_TZ = 'Asia/Yekaterinburg';
// в журнал задачи пишут аккаунт ярлыком (номером) — в ленте показываем имя
const events = makeEvents({ DIR, tz: WORK_TZ, nameOf: (who) => {
  const a = accounts.list().find((x) => x.title === who || x.id === who);
  return a ? (a.name || a.title) : who;
} });
// тексты старых ответов, которые followup.py дотянул из диалогов (у ранних строк followup.csv их нет)
const oldTexts = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'followup-texts.json'), 'utf8')) || {}; } catch { return {}; } };
// переписка с ответившими — её пишет followup.py в talks/<акк>.json; держим до правки файла
const talkCache = new Map();
function talksOf(acc) {
  if (!/^[\w-]+$/.test(String(acc || ''))) return {};
  const f = path.join(DIR, 'talks', `${acc}.json`);
  let st;
  try { st = fs.statSync(f); } catch { return {}; }
  const hit = talkCache.get(acc);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch {}
  talkCache.set(acc, { mtimeMs: st.mtimeMs, data });
  return data;
}
const results = makeResults({ readRaw, tz: WORK_TZ, replyOf: (k) => events.replyOf(k), oldTexts,
                              talkOf: (acc, key) => talksOf(acc)[key] || null });

/**
 * Разовая разметка ролей для аккаунтов, заведённых до разделения прогрева и
 * рассылки: кто уже писал людям — остаётся в рассылке, кто не писал ни разу —
 * только прогрев. Иначе свежие аккаунты молча попали бы в рассылку.
 */
let wroteCache = { at: 0, ids: new Set(), last: new Map() };
function wroteRefresh() {
  if (Date.now() - wroteCache.at <= 60_000) return;
  const rows = [...readRaw('drafts.csv'), ...readRaw(path.join('chats', 'drafts.csv'))]
    .filter((r) => r.sent === 'true' || r.ok === 'true');
  const last = new Map();
  for (const r of rows) {
    const t = Date.parse(r.at) || 0;
    if (t > (last.get(r.account) || 0)) last.set(r.account, t);
  }
  wroteCache = { at: Date.now(), ids: new Set(rows.map((r) => r.account)), last };
}
/** Кто из аккаунтов хоть раз писал людям (оба набора). Кэш на минуту: зовётся каждый тик. */
function wroteAny() {
  wroteRefresh();
  return wroteCache.ids;
}
/** Когда аккаунт последний раз написал человеку (мс), 0 — ни разу. */
function lastWroteAt(id) {
  wroteRefresh();
  return wroteCache.last.get(id) || 0;
}
for (const a of accounts.list()) {
  if (!a.role) accounts.setField(a.id, { role: wroteAny().has(a.id) ? 'send' : 'warm' });
}

/**
 * Прогрев кончился — аккаунт сам переходит в рассылку.
 *
 * Раньше он так и оставался «только прогревом», пока про него не вспомнят:
 * во вкладке прогрева висел готовый аккаунт, а в рассылке его не было.
 * Теперь созревший уходит из прогрева и появляется свободным в обеих
 * вкладках рассылки — там его можно отметить и пустить в работу.
 *
 * Делаем это ОДИН раз на аккаунт (отметка `graduated`): если потом его
 * вернут на «только прогрев» руками, это решение человека, и мы его не
 * переигрываем.
 */
function graduateWarm() {
  for (const a of accounts.list()) {
    if (a.graduated || a.role !== 'warm') continue;
    if (!accounts.hasSession(a) || !accounts.isAuthed(a)) continue;
    const w = warm(a);
    if (!w.atMax || w.resting) continue;
    accounts.setField(a.id, { role: 'send', graduated: true });
    events.note('✅', `прогрев закончен (день ${w.day}) — аккаунт перешёл в рассылку, можно пускать в прогон`, a.title);
  }
}
setInterval(graduateWarm, 5 * 60_000);

// ── Автозамена мёртвых аккаунтов из резерва (banned-account-replacement) ──────
// Резерв — аккаунты с reserve:true (прогретые запасные; в работу не идут, пока
// не активированы). Когда активный аккаунт умирает (сессия отозвана / заморозка /
// бессрочное ограничение) и держится мёртвым дольше грейса (вдруг разморозят или
// вернут вручную) — его роль (персона) переходит на старейший резервный: тот
// активируется (reserve снимается, идёт в прогрев с нуля), мёртвый уходит в
// retired. Перенос владения каналом-переходником — позже (канальной модели пока
// нет), v1 только подменяет рабочий аккаунт.
const RESERVE_DEAD_GRACE = 24 * 3600 * 1000;
let reserveEmptyNoted = false;

function deadReason(a) {
  if (a.spamKind === 'frozen') return 'заморожен';
  if (a.spamKind === 'perm') return 'бессрочное ограничение';
  if (a.authed === false) return 'сессия отозвана';
  return 'мёртв';
}
// Мёртвый РАБОЧИЙ аккаунт: входил (есть сессия), не резерв/не retired, и либо
// сессия отозвана, либо заморозка/бессрочка. Временные ограничения (temp) сами
// снимаются — их не заменяем.
function isDeadActive(a) {
  if (a.reserve || a.retired) return false;
  if (!accounts.hasSession(a)) return false;
  return a.authed === false || a.spamKind === 'frozen' || a.spamKind === 'perm';
}

function reserveTick() {
  // грейс: ставим/снимаем отметку deadSince, чтобы не заменять то, что может ожить
  for (const a of accounts.list()) {
    const dead = isDeadActive(a);
    if (dead && !a.deadSince) accounts.setField(a.id, { deadSince: new Date().toISOString() });
    else if (!dead && a.deadSince) accounts.setField(a.id, { deadSince: '' });
  }
  const now = Date.now();
  const toReplace = accounts.list().filter((a) => isDeadActive(a)
    && a.deadSince && now - (Date.parse(a.deadSince) || now) >= RESERVE_DEAD_GRACE);
  for (const d of toReplace) {
    const spare = accounts.list().filter((a) => a.reserve === true && !a.retired
        && accounts.hasSession(a) && accounts.isAuthed(a)
        && a.spamKind !== 'frozen' && a.spamKind !== 'perm')
      .sort((x, y) => (Date.parse(x.warmFrom || x.added || 0) || 0) - (Date.parse(y.warmFrom || y.added || 0) || 0))[0];
    if (!spare) {
      if (!reserveEmptyNoted) {
        reserveEmptyNoted = true;
        events.note('⚠', `нужна замена «${d.title}» (${deadReason(d)}), но резерв пуст — добавь аккаунт с reserve`);
      }
      break;
    }
    reserveEmptyNoted = false;
    // активируем резерв: берёт роль (персону) мёртвого и идёт в прогрев с нуля
    accounts.setField(spare.id, { reserve: false, persona: d.persona || spare.persona || '',
      warmFrom: new Date().toISOString(), role: 'warm', graduated: false, replacedFrom: d.id,
      note: `активирован из резерва вместо «${d.title}»` });
    accounts.setField(d.id, { retired: true, deadSince: '', replacedBy: spare.id,
      note: `${deadReason(d)} — заменён на «${spare.title}» из резерва` });
    push(`\n♻ автозамена: «${d.title}» (${deadReason(d)}) → в работу из резерва «${spare.title}» (пойдёт в прогрев)`);
    events.note('♻', `автозамена: «${d.title}» ${deadReason(d)} → активирован резерв «${spare.title}»`, spare.title);
    // TODO: перенос владения каналом-переходником на spare — когда появится канальная модель
  }
}
setTimeout(reserveTick, 8_000);            // первый проход вскоре после старта, не ждать 5 мин
setInterval(reserveTick, 5 * 60_000);

const proxyOf = (id) => accounts.list().find((a) => a.id === id)?.proxy || '';
const proxyGuard = makeProxyGuard({
  parseProxy: accounts.parseProxy,
  label: accounts.proxyLabel,
  proxies: () => accounts.list().filter((a) => accounts.hasSession(a)).map((a) => a.proxy).filter(Boolean),
  rotateLink: () => warmup.rotate || auto.rotate || '',
  rotateIp: (url) => rotateIp(url),
  note: (icon, text) => events.note(icon, text),
  // Пока мы сами переключаем модем, прокси и должен не отвечать. Без этого
  // сторож честно объявлял наше же переключение падением — отсюда и лента,
  // наполовину состоящая из «прокси лежит… прокси снова работает».
  switching: () => Date.now() < Math.max(warmup.holdUntil || 0, auto.holdUntil || 0),
});

const stats = makeStats({ DIR, readCsv });
const { counts, replies, total: statsTotal } = stats;
const statsFold = stats.fold;
// чистка уносит оба набора — и в «за всё время» должны уйти числа обоих
const countsAll = makeStats({ DIR, readCsv: readAll }).counts;
// числа отдельно по каждому набору: вкладки рассылки показывают свои, а не
// те, что сейчас выбраны для экранов
const countsOf = Object.fromEntries(SETS.map((s) =>
  [s, makeStats({ DIR, readCsv: (name) => readRaw(setPath(name, s)) }).counts]));
const { warm, doneToday, doneTodayAll, setMaxCap, getMaxCap, getPlan,
        checksOf, setCheckMax, getCheckMax,
        setWarmDays, getWarmDays } = makeWarmup({ readCsv: readAll, accounts });

// Платный прокси (Asocks, за гигабайт). Аккаунт у Asocks один на сервер,
// поэтому снимки баланса и трафика пишет только основной профиль (его папка —
// папка кода), второй читает тот же файл. Ключ — asocks.json рядом с кодом.
const asocks = makeAsocks({ dir: CODE });
const llmUsage = makeLlmUsage({ dir: DIR, code: CODE });

/**
 * Потолок одновременных задач. Пока у аккаунтов один прокси на всех, задачи и
 * так идут по одной. Со своим IP у каждого они пойдут параллельно, а сервер
 * маленький (2 ГБ, задача Python ~60–80 МБ): без потолка 18 аккаунтов разом
 * съели бы всю память. TG_MAX_PARALLEL — поменять без правки кода.
 */
const MAX_RUNNING = Math.max(1, Number(process.env.TG_MAX_PARALLEL) || 6);

/** Строки прокси аккаунтов СОСЕДНИХ профилей: чужую сессию Asocks не выдаём. */
function otherProfilesProxies() {
  const files = [];
  if (DIR !== CODE) files.push(path.join(CODE, 'accounts.json'));
  try {
    for (const d of fs.readdirSync(path.join(CODE, 'profiles'))) {
      const f = path.join(CODE, 'profiles', d, 'accounts.json');
      if (path.dirname(f) !== DIR) files.push(f);
    }
  } catch {}
  const out = [];
  for (const f of files) {
    try { for (const a of JSON.parse(fs.readFileSync(f, 'utf8'))) if (a.proxy) out.push(a.proxy); } catch {}
  }
  return out;
}
const ownProxy = makeOwnProxy({
  dir: DIR, asocks,
  gateway: process.env.TG_ASOCKS_GATEWAY || ASOCKS_GATEWAY,
  listAccounts: () => accounts.list(),
  otherProxies: otherProfilesProxies,
  setProxy: (id, raw, prev) => {
    accounts.setProxy(id, raw);
    accounts.setField(id, { proxyPrev: prev, proxyOwn: true });
  },
  note: (a, got, region) => push(`   «${a.title}» → свой IP ${got.ip} (${region}${got.city && got.city !== region ? ', ' + got.city : ''}, ${got.org || got.country})`),
});
if (DIR === CODE) {
  let lastErr = '';
  const asocksTick = () => asocks.snapshot().then(() => { lastErr = ''; }).catch((e) => {
    // одна и та же ошибка раз в полчаса журнал не засоряет — пишем только новую
    if (e.message !== lastErr) { lastErr = e.message; events.note('⚠', `учёт трафика Asocks: ${e.message}`); }
  });
  setTimeout(asocksTick, 20_000);
  setInterval(asocksTick, ASOCKS_EVERY);
  // расход на модель (OpenRouter) — тоже раз в полчаса, тоже только основной профиль
  const llmTick = () => llmUsage.snapshot().catch(() => {});
  setTimeout(llmTick, 30_000);
  setInterval(llmTick, LLM_EVERY);
}

/**
 * Своя сессия Asocks умерла — новая сама. Мобильные сессии изредка пропадают из
 * пула (16.10: у одного аккаунта через 15 минут после раздачи, шлюз отвечает 404).
 * Сторож объявляет такой прокси лежащим, аккаунт встаёт без засчитанного сбоя —
 * и стоял бы, пока человек не нажмёт кнопку. Теперь: лежит своя сессия дольше
 * 5 минут — панель выдаёт этому аккаунту новую (та же проверка, что у кнопки).
 */
const OWN_DEAD_AFTER = 5 * 60_000;       // лежит столько — меняем строку
const OWN_REPLACE_GAP = 60 * 60_000;     // не чаще раза в час на аккаунт — чтобы не гонять по кругу
const OWN_INFO_FRESH = 15 * 60_000;      // данные сторожа считаем свежими столько (проверка раз в 10 мин)
const ownDownSince = new Map();          // id -> когда впервые увидели, что лежит
const ownLastReplace = new Map();        // id -> когда последний раз меняли (анти-флап)
const ownDupSince = new Map();           // id -> с какого момента держится дубль IP (нужно 2 проверки подряд)
setInterval(() => {
  if (!asocks.enabled() || ownProxy.busy()) return;
  const own = accounts.list().filter((a) => a.proxyOwn && accounts.hasSession(a));
  if (own.length < 2) return;
  // Если лежит больше половины своих строк — это сбой самого шлюза Asocks или
  // кончился баланс, а не 9 отдельных поломок. Менять всё разом нельзя: после
  // подъёма шлюза Telegram увидел бы, как все сессии разом переехали. Ждём.
  const downN = own.filter((a) => proxyGuard.down(a.proxy)).length;
  if (downN > own.length / 2) return;   // тихо ждём: шлюз/баланс, а не 9 поломок
  const now = Date.now();
  const bad = new Map();                               // id -> почему меняем
  const canReplace = (id) => now - (ownLastReplace.get(id) || 0) >= OWN_REPLACE_GAP;
  // 1) лежит дольше OWN_DEAD_AFTER
  for (const a of accounts.list()) {
    if (!a.proxyOwn || !accounts.hasSession(a) || !proxyGuard.down(a.proxy)) { ownDownSince.delete(a.id); continue; }
    if (!ownDownSince.has(a.id)) ownDownSince.set(a.id, now);
    else if (now - ownDownSince.get(a.id) >= OWN_DEAD_AFTER && canReplace(a.id)) bad.set(a.id, 'лежит 5+ минут');
  }
  // 2) жива, но «уехала» из страны — по СВЕЖИМ данным сторожа
  for (const a of own) {
    const i = proxyGuard.info(a.proxy);
    if (i.down || !i.ip || now - (i.ipAt || 0) > OWN_INFO_FRESH) continue;
    if (i.country && i.country !== OWN_COUNTRY && canReplace(a.id)) bad.set(a.id, `выход из ${i.country}`);
  }
  // 3) тот же IP, что у соседа — только если у ОБОИХ данные свежие и дубль держится
  //    две проверки подряд (мобильный CGNAT даёт короткие случайные совпадения)
  const byIp = new Map();
  for (const a of own) {
    const i = proxyGuard.info(a.proxy);
    if (i.down || !i.ip || now - (i.ipAt || 0) > OWN_INFO_FRESH) continue;
    if (byIp.has(i.ip)) {
      const b = byIp.get(i.ip);
      const key = [a.id, b.id].sort().join('|');
      if (!ownDupSince.has(key)) ownDupSince.set(key, now);
      else if (now - ownDupSince.get(key) >= 60_000) {   // держится ≥ минуты (2 тика)
        if (canReplace(a.id)) bad.set(a.id, `тот же IP, что у ${b.title}`);
      }
    } else byIp.set(i.ip, a);
  }
  // чистим ключи дублей, которых больше нет
  const liveIps = new Set(own.map((a) => proxyGuard.info(a.proxy).ip).filter(Boolean));
  for (const key of [...ownDupSince.keys()]) {
    const [x, y] = key.split('|');
    const ix = proxyGuard.info((own.find((a) => a.id === x) || {}).proxy).ip;
    const iy = proxyGuard.info((own.find((a) => a.id === y) || {}).proxy).ip;
    if (!ix || ix !== iy || !liveIps.has(ix)) ownDupSince.delete(key);
  }
  if (!bad.size) return;
  const list = own.filter((a) => bad.has(a.id));
  push(`\n🌐 своя строка Asocks под замену: ${list.map((a) => `${a.title} (${bad.get(a.id)})`).join(', ')}`);
  for (const a of list) ownLastReplace.set(a.id, now);   // ставим ДО запуска, чтобы не задвоить
  ownProxy.assign({ ids: list.map((a) => a.id), country: OWN_COUNTRY }).then((r) => {
    for (const x of r) { ownDownSince.delete(x.id); if (!x.ok) ownLastReplace.delete(x.id); }
    const ok = r.filter((x) => x.ok).length;
    events.note('🌐', `замена своих строк Asocks: ${ok} из ${r.length} (${[...new Set(list.map((a) => bad.get(a.id)))].join('; ')})` +
      (ok < r.length ? ' — не вышло: ' + r.filter((x) => !x.ok).map((x) => x.why).join('; ') : ''));
  }).catch((e) => push(`🌐 замена строки не удалась: ${e.message}`));
}, 60_000);

// «За что ушёл трафик»: каждая задача пишет свой объём в traffic.csv (tglib).
// Туннель на этом же сервере (127.x) бесплатный, всё остальное — платный прокси.
const TRAFFIC_TASK = {
  'draft-messages': 'рассылка', 'warmup-activity': 'прогрев', followup: 'смотрит ответы',
  'check-batch': 'проверка номеров', 'parse-chat': 'разбор чатов',
  'enrich-read': 'лиды: чтение чатов', 'enrich-find': 'лиды: поиск чатов',
  profile: 'профиль', stats: 'сводка', 'cleanup-contacts': 'уборка контактов',
};
function trafficView(read = readRaw) {
  const rows = read('traffic.csv');
  const now = Date.now();
  const agg = (since) => {
    const byTask = {}, byAcc = {};
    let total = 0, paid = 0;
    for (const r of rows) {
      if (!(Date.parse(r.at) >= since)) continue;
      const b = (Number(r.up) || 0) + (Number(r.down) || 0);
      total += b;
      if (!/^(127\.|localhost|direct)/.test(r.proxy || '')) paid += b;
      const t = TRAFFIC_TASK[r.task] || r.task || '?';
      byTask[t] = (byTask[t] || 0) + b;
      byAcc[r.account] = (byAcc[r.account] || 0) + b;
    }
    return { total, paid, byTask, byAcc };
  };
  return { day: agg(now - 864e5), week: agg(now - 7 * 864e5), month: agg(now - 30 * 864e5) };
}
const { TDESK_HINT, tdesktopApp, launchDesktop, unpackTdata } = desktop;
const DESKTOP = path.join(DIR, 'desktop');

const PORT = Number(arg('port', process.env.PORT || 8787));
const HOST = arg('host', process.env.HOST || '127.0.0.1');
const CERT = arg('cert', ''), KEY = arg('key', '');
const TLS = !!(CERT && KEY);
const LOCAL = /^(127\.|::1|localhost$)/.test(HOST);

/* ═══════════ РЕЕСТР ЗАДАЧ — какой скрипт за что отвечает ═══════════ */

/**
 * Задачи панели. Работа идёт родным каналом Telegram (MTProto) через
 * Telethon — это Python, поэтому у задач помечен свой запускающий.
 * Старые скрипты на Playwright лежат рядом (*.mjs) и запускаются руками:
 * они больше не нужны для работы, но и не мешают.
 */
const TASKS = {
  login:  { title: 'Вход в Telegram',  cmd: ['login-qr.py'],        py: true },
  // вход по номеру: код панель спрашивает у человека и передаёт скрипту файлом
  code:   { title: 'Вход по коду',     cmd: ['login-code.py'],      py: true, phone: true },
  check:  { title: 'Проверка базы',    cmd: ['check-batch.py'],     py: true, opts: true },
  drafts: { title: 'Черновики',        cmd: ['draft-messages.py'],  py: true, opts: true, send: true, voice: true },
  stats:  { title: 'Сводка',           cmd: ['stats.py'],           py: true },
  clean:  { title: 'Чистка контактов', cmd: ['cleanup-contacts.py'],py: true },
  proxy:  { title: 'Проверка прокси',  cmd: ['proxy-check.py'],     py: true },
  // перенос уже вошедшего в браузере аккаунта на Telethon: ключ тот же,
  // заново сканировать QR не нужно
  migrate:{ title: 'Перенос сессии',   cmd: ['import-account.py'],  py: true,
            extra: ['--from-profile'] },
  // разбор чатов: получатели не из таблицы с номерами, а прямо из групп —
  // одной ссылкой либо целой папкой Telegram
  parse:  { title: 'Разбор чатов',     cmd: ['parse-chat.py'],      py: true, chat: true },
  // прогрев поведением: одно человеческое действие за запуск
  warmup: { title: 'Прогрев',          cmd: ['warmup-activity.py'], py: true },
  // второй шаг воронки: ссылка тем, кто ответил на первое письмо
  // по сути это «заглянуть, кто ответил»: пишет задача, только если ответили «да»
  follow: { title: 'Смотрит ответы',   cmd: ['followup.py'],        py: true,
            opts: true, send: true },
  // обогащение: читатель выкачивает один чат из очереди (server/enrich.mjs)
  enrichRead: { title: 'Чтение чата',  cmd: ['enrich-read.py'],     py: true },
  // поиск чатов по ключевикам — порция запросов за заход
  enrichFind: { title: 'Поиск чатов',  cmd: ['enrich-find.py'],     py: true },
};

/**
 * Получатель в наших CSV лежит под колонкой phone, но это не всегда номер:
 * у людей из разбора чата там @username или id:<id> (см. «Ключ получателя»
 * в tglib.py). Проверять по номеру их не нужно — писать можно сразу.
 */
const isPhone = (key) => String(key || '').startsWith('+');

/**
 * Аккаунт на карантине: @SpamBot сказал, что на нём ограничение.
 *
 * Отметку ставит сама задача, когда спрашивает бота перед заходом. Держим
 * её сутки: ограничения Telegram обычно снимаются по времени, и вечно
 * вычёркивать аккаунт из-за одного вчерашнего вердикта неправильно.
 */
const QUARANTINE = 24 * 3600 * 1000;
// SpamBot называет дату снятия — держим ровно до неё; бессрочное — пока бот
// не скажет «свободен»; ответ без даты и без ясности — по-старому, сутки
const inQuarantine = (acc) => {
  if (acc.spamOk !== false || !acc.spamAt) return false;
  if (acc.spamKind === 'perm' || acc.spamKind === 'frozen') return true;  // бессрочно, раньше даты: заморозку/бессрочку дата снятия не отпускает
  if (acc.spamUntil) return Date.now() < Date.parse(acc.spamUntil);
  return Date.now() - Date.parse(acc.spamAt) < QUARANTINE;
};

/** Что сейчас крутится: ключ — аккаунт (или '_base' для разбора файла). */
const running = new Map();
/**
 * Аккаунты, на которых прямо сейчас идёт вход/выгон (access.py).
 * Он работает той же сессией аккаунта, что и рассылка, а два процесса на
 * одной сессии дают «database is locked». Задачи запускаются мимо running
 * (через execFileSync в обработчике запроса), поэтому автопрогон их не видит
 * — этот набор и есть недостающий «аккаунт занят».
 */
const accessBusy = new Set();
const log = [];                       // кольцевой буфер строк
const push = (line) => {
  log.push(line); if (log.length > 1000) log.shift();
  events.fromPanel(line);
};

/** Метка строки с итогом пачки: её печатает tglib.state() в конце задачи. */
const STATE_MARK = '\u2301STATE ';

/**
 * Уборка после выхода из аккаунтов: панель становится как новая, а числа
 * остаются. Всё, что человек собирал руками (база, результаты, история
 * сообщений, загруженные файлы), уезжает в бэкап-папку рядом с панелью;
 * туда же — реестр аккаунтов и файлы сессий: если у какого-то аккаунта выйти
 * не вышло, его сессия ещё живая, и терять её нельзя. Насовсем удаляем только
 * восстановимое: профили браузера, картинку QR, брони.
 * Вход в панель (auth.json), текст сообщения и накопленную сводку не трогаем.
 */
function wipeAll() {
  const at = new Date().toISOString();
  const stamp = at.replace(/[:T]/g, '-').slice(0, 19);
  const backup = path.join(DIR, `_backup_${stamp}`);
  fs.mkdirSync(backup, { recursive: true });
  const move = (name) => {
    const src = path.join(DIR, name);
    if (fs.existsSync(src)) { fs.renameSync(src, path.join(backup, name)); return true; }
    return false;
  };
  const wipe = (name) => { try { fs.rmSync(path.join(DIR, name), { recursive: true, force: true }); } catch {} };

  // числа снимаем ДО того, как унести файлы: после переноса считать будет нечего
  const now = countsAll();
  const had = accounts.list().length;

  let saved = 0;
  for (const f of ['numbers.csv', 'base.json', 'results.csv', 'drafts.csv', 'members.csv',
                   'chats.json', 'warmup.csv', 'warmup.json', 'followup.csv', 'mirror.json',
                   'accounts.json', 'sessions', 'uploads', 'voice.ogg', 'voice.json', 'replies.json',
                   'chats', 'base-set.json', 'enrich']) {
    if (move(f)) saved++;
  }
  for (const f of ['tg-profile', 'accounts', 'qr', 'claims.json', 'desktop']) wipe(f);
  // пустой бэкап (чистили уже чистую панель) не оставляем
  let rel = path.basename(backup);
  if (!saved) { try { fs.rmdirSync(backup); } catch {} rel = ''; }

  // и только теперь — в кеш: чистку начисто в историю не пишем, иначе она
  // копила бы пустые строки с папками, которых нет
  const total = saved || had
    ? statsFold(now, { at, accounts: had, backup: rel })
    : statsTotal({ checked: 0, found: 0, none: 0, drafts: 0, sent: 0 });

  push(`🧹 чисто: аккаунтов в панели нет` + (rel ? `, данные в ${rel}` : ''));
  push(`   сводка за всё время осталась: проверено ${total.checked} · найдено ${total.found}` +
       ` · написано ${total.drafts} · отправлено ${total.sent}`);
  return { backup: rel ? path.join(DIR, rel) : '' };
}

/**
 * Запуск дочернего процесса под ключом. Аккаунты идут параллельно, поэтому
 * вывод помечаем именем — иначе в общем логе не разобрать, кто что пишет.
 */
/**
 * Ручные действия с аккаунтами (имя, аватар, вход, сессия…) ставят прогон и
 * прогрев на паузу: новые задачи они не берут, пока ты работаешь руками, и
 * ещё немного после — чтобы ручное действие и рассылка не шли одновременно
 * с одного адреса. Кто запустил задачу, помечаем при запуске.
 */
let launchedBy = 'manual';                 // auto | warm | manual
const MANUAL_GRACE = 2 * 60_000;           // после ручного действия ждём ещё столько
let manualUntil = 0;
let manualNoted = false;
const manualBusy = () => [...running.values()].some((r) => r.by === 'manual')
  || Date.now() < manualUntil;
function manualHold() {
  if (manualBusy()) {
    if (!manualNoted) {
      manualNoted = true;
      events.note('⏸', 'прогон на паузе — идёт ручное действие с аккаунтами');
    }
    return true;
  }
  if (manualNoted) {
    manualNoted = false;
    events.note('▶', 'ручное действие закончено — продолжаю');
  }
  return false;
}
/* ═══════════ ЗАПУСК ЗАДАЧ — порождение процесса и разбор его вывода ═══════════ */

/**
 * Обогащение — поиск лидов «хочет квартиру» по чатам (server/enrich.mjs).
 * Читатели берут чаты по одному, разбор идёт следом; задачи запускаем как
 * автоматику (launchedBy = 'auto'), иначе каждый заход читателя ставил бы
 * автопрогон рассылки на ручную паузу.
 */
const enrich = makeEnrich({
  DIR, CODE, accounts, running, pythonCmd, push, readRaw,
  launch: (name, opts, onDone) => {
    launchedBy = 'auto';
    try { return start(name, opts, onDone); } finally { launchedBy = 'manual'; }
  },
  note: (icon, text) => events.note(icon, text),
  busy: (id) => accessBusy.has(id),
  proxyDown: (proxy) => proxyGuard.down(proxy),
  resting: (a) => warm(a).resting,                           // первые сутки — отлёжка
  slots: () => MAX_RUNNING - running.size,                   // общий потолок задач
  readerCap: Math.max(1, Math.floor(MAX_RUNNING / 2)),        // читателям — не больше половины
});


function run(key, tag, title, cmd, args, onDone, set = baseSet) {
  // Python-задаче говорим, с каким набором получателей работать (tglib.py)
  const child = spawn(cmd, args, { cwd: DIR, env: { ...process.env, TG_SET: set } });
  const rec = { child, title, since: Date.now(), state: null, by: launchedBy };
  running.set(key, rec);
  push(`\n▶ ${title}: ${args.map((a) => path.basename(a)).join(' ')}`);
  // Последняя строка задачи — итог для панели, а не для человека: сколько
  // сделано, сколько осталось и не придержал ли Telegram аккаунт. В журнал
  // её не пишем — по ней решает автопрогон.
  const feed = (b) => String(b).split('\n').filter(Boolean).forEach((l) => {
    if (l.startsWith(STATE_MARK)) {
      try { rec.state = JSON.parse(l.slice(STATE_MARK.length)); } catch {}
      return;
    }
    push(`[${tag}] ${l}`);
    events.fromTask(tag, title, l);
  });
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('close', (code) => {
    push(`■ ${title} завершено (код ${code})`);
    running.delete(key);
    if (rec.by === 'manual') manualUntil = Date.now() + MANUAL_GRACE;
    onDone?.(code, rec.state);
  });
}

function start(name, opts, onDone) {
  const { account, limit, delay, send, voice, chat, folder, again, onlyUser,
          join, phone, list, days } = opts;   // остальные паузы берутся из opts по месту
  const t = TASKS[name];
  if (!t) return { ok: false, reason: 'неизвестная задача' };
  let acc;
  try { acc = accounts.resolve(account); } catch (e) { return { ok: false, reason: e.message }; }
  // Набор захода: явно названный вкладкой (opts.set), иначе — тот, в котором
  // аккаунт уже работает, и лишь затем базовый. Раньше всегда решал setOf(acc.id):
  // ручной заход с вкладки чатов брал текст «по номерам», а файлы и брони —
  // корневые, хотя человек стоял на вкладке чатов.
  const set0 = opts.set || setOf(acc.id);
  const cur = running.get(acc.id);
  if (cur) return { ok: false, reason: `«${acc.title}» уже занят: ${cur.title}` };
  // на этом аккаунте сейчас создают вход или выгоняют устройство — та же сессия
  if (accessBusy.has(acc.id)) return { ok: false, reason: `«${acc.title}»: идёт вход/выгон на компьютер — подожди` };

  // задачи, которым нужна живая сессия: без входа запускать бессмысленно —
  // раньше это молча падало «нет сессии» и путало (проверка/рассылка вхолостую)
  const NEEDS_SESSION = ['check', 'drafts', 'stats', 'clean', 'parse', 'follow', 'enrichRead', 'enrichFind'];
  if (NEEDS_SESSION.includes(name) && !accounts.hasSession(acc)) {
    return { ok: false, reason: `«${acc.title}» не вошёл — сначала войди по QR или залей сессию (шаг 1)` };
  }

  // карантин: Telegram уже сделал этому аккаунту замечание. Писать с него —
  // значит дожать до вечной блокировки. Проверка/разбор/прогрев остаются:
  // они не рассылка, и через них аккаунт как раз отлежится
  // отвечать тем, кто написал сам, Telegram под ограничением разрешает —
  // второе письмо не блокируем, только первые письма незнакомым
  if (name === 'drafts' && inQuarantine(acc)) {
    return { ok: false, reason: `«${acc.title}» на карантине: ${acc.spam || 'ограничение от Telegram'}. ` +
      'Рассылка с него не идёт, база остаётся на месте.' };
  }

  // отлёжка: пока аккаунт «молодой», его нельзя дёргать даже вручную —
  // ради этого прогрев и заводился. Отключается флагом warm:false.
  let sendLimit = limit;
  // отдых после заморозки: ни писем, ни заведения контактов — и вручную тоже
  if (['check', 'drafts'].includes(name) && accounts.sendHoldLeft(acc)) {
    return { ok: false, reason: `«${acc.title}» после заморозки без рассылки до ` +
      `${ekbDateTime(Date.now() + accounts.sendHoldLeft(acc))} по Екб — людям не пишет` };
  }
  if (['check', 'drafts', 'follow'].includes(name)) {
    const w = warm(acc);
    // отлёжку можно отключить галкой (для зрелых аккаунтов), а дневной потолок — нет
    if (opts.warm !== false && w.resting) {
      return { ok: false, reason: `«${acc.title}» на отлёжке — ещё ${fmtLeft(w.restLeft)}. ` +
        'Свежий аккаунт первые сутки не трогаем, иначе Telegram его забанит.' };
    }
    // у проверки номеров свой дневной предел: это «добавить в контакты», и
    // упираться в квоту Telegram на это регулярно нельзя
    if (name === 'check') {
      const c = checksOf(acc.id);
      if (c.left <= 0) {
        return { ok: false, reason: `«${acc.title}» проверил на сегодня ${c.today} из ${c.cap} номеров. Продолжит завтра.` };
      }
      sendLimit = Math.min(Number(limit) || c.left, c.left);
    }
    // дневной предел — про первые письма незнакомым. Второе письмо — ответ
    // тому, кто сам написал «да»: ему не ждать до завтра, и отказ тут считался
    // бы в автопрогоне сбоем — с повтором каждые 5 минут и выбыванием аккаунта
    if (name === 'drafts') {
      if (w.left <= 0) {
        return { ok: false, reason: `«${acc.title}» выбрал дневной предел ` +
          `(${w.cap} в сутки, день ${w.day}). Вернётся завтра.` };
      }
      // ручной заход не шлёт больше дневного остатка — держим ВСЕГДА
      sendLimit = Math.min(Number(limit) || w.left, w.left);
    }
  }

  // пустой текст = холостой прогон, который жжёт номера: не запускаем.
  // «По чатам» берёт СВОЙ текст (message-chat.txt, с падением на общий), «по
  // номерам» — общий (message.txt), второе письмо — message2.txt. Тексты вкладок
  // независимы: у чатов свой текст не должен требовать текста «по номерам».
  if (['drafts', 'follow'].includes(name)) {
    const read = (f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8').trim(); } catch { return ''; } };
    // «Смотрит ответы» без второго шага ничего не шлёт — только читает диалоги,
    // текст второго письма ему не нужен (followup.py требует его лишь при --send).
    // Раньше без message2.txt эта проверка роняла запуск посреди отдыха, и
    // 40-минутный сон между порциями превращался в 5-минутный.
    const txt = name === 'follow' ? (send ? read('message2.txt') : 'только читает')
      : set0 === 'chats' ? (read('message-chat.txt') || read('message.txt'))
      : read('message.txt');
    if (!txt) {
      return { ok: false, reason: 'сначала напиши текст сообщения — иначе рассылка пройдёт вхолостую и сожжёт номера' };
    }
  }

  // голосовое уходит сразу и требует файла — без него запускать нечего
  if (t.voice && voice && !fs.existsSync(VOICE)) {
    return { ok: false, reason: 'сначала загрузи голосовое (шаг 4)' };
  }

  // разбор без цели запускать некуда: либо ссылка на чат, либо папка Telegram
  if (t.chat && !String(chat || '').trim() && !String(folder || '').trim() && !String(list || '').trim()) {
    return { ok: false, reason: 'вставь ссылку на чат или назови папку Telegram' };
  }
  if (t.phone && !/^\+?\d{7,15}$/.test(String(phone || '').replace(/[\s()-]/g, ''))) {
    return { ok: false, reason: 'нужен номер телефона аккаунта, например +79001112233' };
  }

  const args = [path.join(CODE, ...t.cmd), '--account', acc.id, ...(t.extra || [])];
  if (t.opts) {
    if (sendLimit) args.push('--limit', String(sendLimit));
    if (delay) args.push('--delay', String(delay));
    if (opts.delayMax) args.push('--delay-max', String(opts.delayMax));
    if (opts.hold) args.push('--hold', String(opts.hold));
    if (opts.holdMax) args.push('--hold-max', String(opts.holdMax));
  }
  if (t.chat) {
    if (String(list || '').trim()) {
      // список ссылок пишем в файл — их бывают десятки, в командную строку
      // столько не влезет, да и незачем
      const f = path.join(DIR, 'chat-list.txt');
      fs.writeFileSync(f, String(list).trim() + '\n');
      args.push('--list', f);
    } else if (String(folder || '').trim()) {
      args.push('--folder', String(folder).trim());
    } else {
      args.push('--chat', String(chat).trim());
    }
    if (limit) args.push('--limit', String(limit));
    if (days) args.push('--days', String(days));
    if (join) args.push('--join');
    if (again) args.push('--again');
    if (onlyUser) args.push('--only-username');
    // разбор в несколько аккаунтов: этот — i-й из N, чаты делят бронью (startParseAll)
    if (opts.shards > 1) args.push('--share', `${opts.shard}/${opts.shards}`);
  }
  if (t.phone) args.push('--phone', String(phone).replace(/[\s()-]/g, ''));
  if (t.voice && voice) args.push('--voice');
  else if (t.send && send) args.push('--send');
  // параллель на общем IP — письма разных аккаунтов разводятся по времени
  if (t.send && opts.sendGap) args.push('--send-gap');
  // «Написать лидам»: из очереди по чатам — только лиды обогащения
  if (name === 'drafts' && opts.leadsOnly) args.push('--leads-only');
  // догрев между пачками рассылки — свои, лёгкие действия
  if (name === 'warmup' && opts.between) args.push('--between');
  // «живой день»: аккаунт из рассылки греется весь день по потолку «между пачками»
  if (name === 'warmup' && opts.lively) args.push('--lively');
  // одно конкретное действие прогрева (замороженному — только SpamBot)
  if (name === 'warmup' && opts.what) args.push('--what', String(opts.what));
  // временно ограничен SpamBot, но разрешено комментировать (comments.held_accounts)
  if (name === 'warmup' && opts.held) args.push('--held');
  // «(с отправкой)» — только у рассылки: у проверки ответов это читалось так,
  // будто аккаунт пишет людям, хотя он лишь смотрит диалоги
  const tag = t.voice && voice ? ' (голосовое)' : t.send && send && name !== 'follow' ? ' (с отправкой)' : '';
  // набор можно задать явно: проба квоты идёт по базе номеров, даже когда
  // рассылка сейчас работает по чатам
  run(acc.id, acc.title, `${t.title} — ${acc.title}${tag}`,
      t.py ? pythonCmd() : 'node', args, onDone, set0);
  return { ok: true };
}

/* ------------------------------------------------------- прогрев поведением
 *
 * Свежий аккаунт, который сразу пошёл писать незнакомым, живёт недолго. Живой
 * человек сначала на что-то подписан, что-то читает, где-то ставит реакции и
 * с кем-то переписывается — и только потом пишет по делу. Этим узлом панель
 * и занимается: водит аккаунты по обычным делам, пока они молодые.
 *
 * Ритм намеренно медленный и рваный, как у человека:
 *   • одно действие за запуск — пачками нельзя, это первый признак робота;
 *   • между действиями внутри сессии 2–4 минуты;
 *   • после 2–3 действий аккаунт уходит спать на 2–4 часа;
 *   • первые сутки не делает вообще ничего.
 *
 * Сколько чего в сутки — решает сам скрипт по возрасту аккаунта; панель только
 * выдерживает паузы и следит, чтобы аккаунты не шли одновременно, когда прокси
 * один на всех.
 */
const WARM_FILE = path.join(DIR, 'warmup.json');
const WARM_TICK = 30_000;                 // как часто смотрим, кому пора
const WARM_GAP = [120, 240];              // пауза между действиями, сек
const WARM_NAP = [2 * 3600, 4 * 3600];    // сон между сессиями, сек
const WARM_SESSION = [2, 3];              // столько действий в одной сессии

const rnd = (a, b) => Math.round(a + Math.random() * (b - a));

const warmup = { on: false, per: new Map(), timer: null,
                 rotate: '', rotateWait: 10, fresh: false, holdUntil: 0,
                 lastId: '', pending: '',
                 // кого греем: список id. Пусто — всех вошедших (как было). Галочки
                 // на вкладке «Прогрев» дают греть только отмеченных — удобно, когда
                 // часть аккаунтов надо отложить/догреть отдельно.
                 only: [],
                 // догрев между пачками рассылки — настройка профиля, по умолчанию выкл.
                 between: false };

// Догрев между пачками: только в глубоком сне между порциями писем, и только
// если до следующей порции ещё не меньше стольких минут — одно действие с
// подключением занимает минуту-две, впритык к письму его не втискиваем.
const BETWEEN_MIN_LEFT = 10 * 60_000;
// эти паузы — про обычный прогрев («на сегодня всё», «поспи пару часов»);
// догрев между пачками их не ждёт. Отлёжку после флуда и сбои — ждёт.
const BETWEEN_SKIP_WAIT = new Set(['', 'дневной предел прогрева', 'спит после сессии']);
// Настройки комментариев (раздел comments в warm-list.json — его правит хозяин,
// задачи читают сами). Панели нужно немногое: включены ли и кому из временно
// ограниченных их разрешили. Файл перечитываем, только когда он изменился.
let commentsCfgCache = { mtime: -1, cfg: {} };
function commentsCfg() {
  const file = path.join(DIR, 'warm-list.json');
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return {}; }
  if (mtime !== commentsCfgCache.mtime) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')).comments || {}; } catch {}
    commentsCfgCache = { mtime, cfg };
  }
  return commentsCfgCache.cfg;
}
const commentsHeld = () => {
  const c = commentsCfg();
  return new Set(c.on ? (c.held_accounts || []) : []);
};
// Записать поля в раздел comments в warm-list.json, сохранив остальное (его же
// читают задачи). Атомарно, с инвалидацией кэша commentsCfg().
function writeCommentsCfg(patch) {
  const file = path.join(DIR, 'warm-list.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  all.comments = { ...(all.comments || {}), ...patch };
  fs.writeFileSync(file + '.tmp', JSON.stringify(all, null, 1) + '\n');
  fs.renameSync(file + '.tmp', file);
  commentsCfgCache.mtime = -1;   // перечитать при следующем commentsCfg()
  return all.comments;
}
// сутки по Екатеринбургу — «между пачками на сегодня всё» живёт до полуночи
const ekbDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(new Date());

// «ЖИВОЙ ДЕНЬ» — та же настройка профиля (warmup.between). Кроме догрева между
// пачками она меняет ритм прогрева всего профиля: обычный прогрев выбирал свои
// 1–2 действия к 10 утра и дальше молчал до завтра. Теперь сессии мельче и чаще,
// а сон между ними считается так, чтобы остаток действий на сегодня растянулся
// до вечера. Ночью человек в Telegram не сидит — с 23 до 8 по Екб прогрева нет.
const LIVELY_SESSION = [1, 2];            // действий за сессию (обычно 2–3)
const LIVELY_GAP = [90, 180];             // пауза между действиями сессии, сек (обычно 120–240)
const LIVELY_NAP = [40 * 60, 150 * 60];   // сон между сессиями: границы, сек (обычно 2–4 ч)
const LIVELY_FROM = 8, LIVELY_TO = 23;    // часы по Екб, когда прогрев вообще идёт
// сколько мс до ближайшего h:00 по Екатеринбургу (UTC+5, без перехода на летнее)
const msUntilEkbHour = (h) => {
  const now = Date.now();
  const e = new Date(now + 5 * 3600e3);
  let t = Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate(), h) - 5 * 3600e3;
  if (t <= now) t += 864e5;
  return t - now;
};
// Сон после сессии в «живом дне»: остаток действий на сегодня (его сообщает
// скрипт) делим на время до вечера. Много осталось — спим меньше, мало — дольше.
function livelyNap(left) {
  const [lo, hi] = LIVELY_NAP.map((x) => x * 1000);
  if (!(left > 0)) return rnd(LIVELY_NAP[0], LIVELY_NAP[1]) * 1000;
  const sessions = Math.max(1, Math.ceil(left / 1.5));
  const even = msUntilEkbHour(LIVELY_TO) / (sessions + 0.5);
  return Math.round(Math.min(hi, Math.max(lo, even * (0.8 + Math.random() * 0.4))));
}

function warmSave() {
  const per = {};
  for (const [id, v] of warmup.per) per[id] = v;
  try {
    fs.writeFileSync(WARM_FILE, JSON.stringify(
      { on: warmup.on, rotate: warmup.rotate, rotateWait: warmup.rotateWait,
        maxCap: getMaxCap(), checkMax: getCheckMax(), warmDays: getWarmDays(),
        between: warmup.between, only: warmup.only, per }, null, 2) + '\n');
  } catch {}
}

function warmLoad() {
  let existed = false;
  try {
    const d = JSON.parse(fs.readFileSync(WARM_FILE, 'utf8'));
    existed = true;
    warmup.on = !!d.on;
    warmup.rotate = String(d.rotate || '');
    warmup.rotateWait = Number(d.rotateWait) || 10;
    warmup.between = !!d.between;
    warmup.only = Array.isArray(d.only) ? d.only : [];
    warmup.per = new Map(Object.entries(d.per || {}));
    setMaxCap(Number(d.maxCap ?? d.dailyCap) || 0);
    if (d.checkMax) setCheckMax(d.checkMax);
    if (d.warmDays) setWarmDays(d.warmDays);
  } catch {}
  // на свежей установке прогрев включаем сам: у новых аккаунтов сутки отлёжки,
  // потом ramp с 1-го дня — тыкать «Включить прогрев» руками не нужно
  if (!existed) warmup.on = true;
  if (warmup.on) warmStart(); else warmSave();
}

/**
 * Можно ли водить аккаунты одновременно.
 *
 * Нельзя, если они выходят с ОДНОГО адреса: два аккаунта, активничающие с
 * одного IP в одну минуту, — это первое, за что Telegram выдаёт ограничения.
 * Одинаковый прокси у двоих — один адрес. Пустой прокси у двоих — тоже один
 * адрес, адрес самого сервера. Свой прокси у каждого — тогда можно.
 */
function ownProxyEach() {
  const live = accounts.list().filter((a) => accounts.hasSession(a) && accounts.isAuthed(a));
  if (live.length < 2) return true;
  const list = live.map((a) => String(a.proxy || ''));
  if (list.some((p) => !p)) return false;
  return new Set(list).size === list.length;
}

/** Смена IP перед следующим аккаунтом прогрева. */
/**
 * Свежий IP перед входом в аккаунт.
 *
 * Когда прокси один на всех, все аккаунты логинятся с одного адреса, а потом
 * прогрев начинает его менять — для Telegram это «сессия переехала», и риск
 * бана выше. Поэтому перед каждым входом (заливка сессии, QR, код) меняем IP,
 * если задана ссылка ротации. Свой прокси у каждого — ссылки нет, шаг пропущен.
 */
async function freshIpForLogin() {
  if (!mirrorRotateLink()) return;
  push('🔄 меняю IP перед входом в аккаунт…');
  let r = await rotateIp(mirrorRotateLink());
  // провайдер требует паузу между сменами — подождём и попробуем ещё раз
  if (!r.ok && /wait|подожд|10s/i.test(r.reason || '')) {
    await new Promise((z) => setTimeout(z, 11000));
    r = await rotateIp(mirrorRotateLink());
  }
  if (r.ok) {
    push(`   ${r.text || 'ок'} — жду ${warmup.rotateWait} с`);
    await new Promise((z) => setTimeout(z, warmup.rotateWait * 1000));
  } else {
    push(`   ✗ сменить IP не вышло: ${r.reason} — вхожу с текущего адреса`);
  }
}

/** Ссылка ротации живёт в настройках прогрева; берём оттуда. */
const mirrorRotateLink = () => warmup.rotate || '';

async function rotateForWarm() {
  warmup.holdUntil = Date.now() + ROTATE_TIMEOUT;
  const r = await rotateIp(warmup.rotate);
  if (!warmup.on) return;
  if (r.ok) {
    warmup.fresh = true;
    warmup.holdUntil = Date.now() + warmup.rotateWait * 1000;
    push(`🌱 сменил IP перед следующим аккаунтом (${r.text || 'ок'})`);
  } else {
    // без смены адреса следующий аккаунт пошёл бы с того же IP, что и прошлый,
    // — ровно то, ради чего ротацию и заводили. Ждём и пробуем ещё раз
    warmup.holdUntil = Date.now() + 10 * 60_000;
    push(`🌱 сменить IP не вышло: ${r.reason} — прогрев подождёт 10 минут`);
  }
}

/** Состояние аккаунта в прогреве: когда следующий шаг и сколько осталось в сессии. */
const warmOf = (id) => {
  if (!warmup.per.has(id)) warmup.per.set(id, { nextAt: 0, left: 0, note: '' });
  return warmup.per.get(id);
};

function warmTick() {
  if (!warmup.on) return;
  if (manualBusy()) return;
  const now = Date.now();
  // общий адрес — значит строго по одному за раз
  const alone = !ownProxyEach() || auto.serial || !!auto.rotate || !!warmup.rotate;
  if (alone && running.size) return;
  if (auto.on && auto.serial && now < auto.holdUntil) return;
  if (now < warmup.holdUntil) return;

  /**
   * Кого спрашиваем первым.
   *
   * Сначала тот, ради кого только что сменили адрес, — иначе свежий IP
   * достанется случайному соседу, а этот пойдёт со старого. Потом те, у кого
   * сессия уже начата: сессия — это два-три действия подряд, и разрывать её
   * чужим аккаунтом (а значит, и чужим адресом) незачем, живой человек так
   * себя не ведёт.
   */
  const live = accounts.list().filter((a) => accounts.hasSession(a) && accounts.isAuthed(a)
    && !a.reserve && !a.retired && !accounts.isReader(a)     // читатель не греется: он только читает
    && (!warmup.only.length || warmup.only.includes(a.id)));
  const rank = (a) => (warmup.pending === a.id ? 0 : (warmOf(a.id).left ? 1 : 2));
  const order = [...live].sort((x, y) => rank(x) - rank(y));

  for (const acc of order) {
    if (running.size >= MAX_RUNNING) return;     // сервер маленький — больше разом не пускаем
    if (running.has(acc.id)) continue;
    if (proxyGuard.down(acc.proxy)) continue;
    // полный отдых после заморозки — не трогаем вовсе; «без рассылки» — греем
    // (скрипт сам перейдёт на догрев после заморозки: реакции и свои)
    if (accounts.fullRestLeft(acc)) continue;
    // аккаунт занят настоящим делом — обычный прогрев подождёт. Иначе он лез
    // бы между пачками рассылки и отнимал у неё и время, и лимиты. Выбравший
    // на сегодня всё (или ночью, когда писать нельзя, а проверять нечего)
    // рассылке уже не нужен — пусть догревается: переписка, чтение, реакции.
    //
    // ДОГРЕВ МЕЖДУ ПАЧКАМИ (настройка профиля). Без него вечером аккаунт между
    // порциями писем по полчаса молчал, а прогрев свой выбирал ещё к обеду —
    // со стороны это «только холодные письма, больше ничего». С ним — в
    // глубоком сне между порциями (не посреди порции и не впритык к письму)
    // ОДНО лёгкое действие на промежуток: лента с реакцией или переписка со
    // своими. Суточный потолок держит сам скрипт (BETWEEN в warmup-activity.py).
    const st = warmOf(acc.id);
    let between = false;
    let gapEnd = 0;
    // ночью (23–8 по Екб) прогрева нет — спим до утра. Раньше так было только
    // с «живым днём»; обычный прогрев мог читать ленту и в три часа ночи
    const lively = warmup.between;
    {
      const h = workHour();
      if (h < LIVELY_FROM || h >= LIVELY_TO) {
        if (st.note !== 'ночь — до утра') {
          st.nextAt = Math.max(st.nextAt || 0, now + msUntilEkbHour(LIVELY_FROM) + rnd(0, 40 * 60) * 1000);
          st.note = 'ночь — до утра';
          st.left = 0;
        }
        continue;
      }
      if (st.note === 'ночь — до утра' && now < st.nextAt) continue;
    }
    // Замороженному любое действие падает FROZEN_* и только светит общий IP.
    // Ему — раз в сутки один вопрос к SpamBot: разморозят (апелляция) —
    // отметка снимется сама, и он вернётся к обычному прогреву.
    // То же — аккаунту, которого прогон снял за ограничение: писать ему нельзя,
    // а прогрев пропускает его, пока он числится в рассылке. Без вопроса к боту
    // не узнать, что бессрочное сняли, — висел бы вечно.
    const heldInRun = auto.on && auto.ids.includes(acc.id) && !!auto.per.get(acc.id)?.quarantine;
    const frozenCheck = acc.spamOk === false && (acc.spamKind === 'frozen' || heldInRun);
    // Временно ограниченному, которого явно разрешили комментировать (comments.held_accounts
    // в warm-list.json), после суточного вопроса SpamBot — 1–2 комментария в день вместо
    // полного простоя. Писать людям в личку ему по-прежнему нельзя.
    const heldComment = frozenCheck && acc.spamKind === 'temp' && st.frozenCheckDay === ekbDay()
      && commentsHeld().has(acc.id);
    if (heldComment) {
      if (st.heldDoneDay === ekbDay() || now < st.nextAt) continue;
    } else if (frozenCheck) {
      if (st.frozenCheckDay === ekbDay() || now < st.nextAt) continue;
    } else if (auto.on && auto.ids.includes(acc.id) && accounts.inOutreach(acc) && !outreachDoneForNow(acc)) {
      const s = auto.per.get(acc.id);
      // не посреди порции, не впритык к письму и не в отлёжку после флуда
      const inGap = warmup.between && s && !s.stopped && !s.chain
        && now >= (s.floodUntil || 0)
        && s.nextAt - now >= BETWEEN_MIN_LEFT;
      if (!inGap || st.betweenFor === s.nextAt || st.betweenDay === ekbDay()) continue;
      if (now < st.nextAt && !BETWEEN_SKIP_WAIT.has(st.note || '')) continue;
      between = true;
      gapEnd = s.nextAt;
    } else if (now < st.nextAt) continue;

    // аккаунт ещё на отлёжке — панель это и так знает по возрасту. Незачем
    // ради него менять IP и поднимать Telethon: он всё равно ничего не делает.
    // Ставим будильник ровно на конец отлёжки и идём искать рабочий аккаунт —
    // так ротация и тики не тратятся на лежащих, а достаются тем, кто греется.
    const wa = warm(acc);
    if (wa.resting) {
      st.left = 0;
      st.nextAt = now + Math.max(wa.restLeft, 60) * 1000;
      st.note = 'отлёжка';
      continue;
    }

    // следующий аккаунт — сначала новый адрес: иначе оба наследят с одного.
    // Запоминаем, КОМУ меняем: без этого свежий адрес достался бы тому, кто
    // первым подвернулся на следующем круге
    // Между пачками IP не меняем: смена уводит модем из сети на минуту, а на
    // этом же прокси сейчас пишут соседи по рассылке.
    if (!between && !frozenCheck && warmup.rotate && warmup.lastId && warmup.lastId !== acc.id
        && !warmup.fresh && !rotatedRecently()) {
      warmup.pending = acc.id;
      rotateForWarm();
      return;
    }

    // новая сессия — заводим счётчик действий; между пачками — ровно одно
    if (between || frozenCheck) st.left = 1;
    else if (!st.left) st.left = lively ? rnd(LIVELY_SESSION[0], LIVELY_SESSION[1])
                                        : rnd(WARM_SESSION[0], WARM_SESSION[1]);

    launchedBy = 'warm';
    // в «живом дне» аккаунт из рассылки греется весь день по потолку «между
    // пачками» (3–4 реакции + 1–2 переписки), а не по скупому догреву 1–2 в сутки
    const livelyCaps = lively && accounts.inOutreach(acc);
    const r = start('warmup', { account: acc.id, warm: false, between, lively: livelyCaps,
                                held: heldComment,
                                what: heldComment ? 'comment' : frozenCheck ? 'spam' : '' }, (code, state) => {
      const s = warmOf(acc.id);
      s.left = Math.max(0, s.left - 1);
      if (state?.act) s.act = state.act;   // что аккаунт сделал последним
      s.actAt = Date.now();
      // между пачками на сегодня всё — до полуночи больше не зовём
      if (between && state?.note === 'дневной предел прогрева') s.betweenDay = ekbDay();
      // ограниченному комментарии на сегодня кончились — до завтрашнего SpamBot
      if (heldComment && state?.note === 'дневной предел прогрева') s.heldDoneDay = ekbDay();
      // замороженного сегодня уже спросили (скрипт не отказал «уже спрашивали»)
      if (frozenCheck && code === 0 && !state?.note && !state?.stop) s.frozenCheckDay = ekbDay();
      if (state?.stop === 'flood' && state.cooldown) {
        s.left = 0;
        // то же правило, что в рассылке: после ограничения — отлёжка ≥ 3 часов
        const until = Date.now() + Math.max(state.cooldown * 1000, REST_AFTER_LIMIT);
        s.nextAt = until;
        s.note = 'Telegram просит паузу — отлёжка 3 ч';
        // ВАЖНО: PEER_FLOOD прилетел на прогреве/комментарии, но ограничение —
        // на уровне аккаунта. Рассылка того же аккаунта должна встать тоже,
        // иначе она продолжит писать незнакомым сразу после сигнала. Пишем
        // floodUntil в реестр (его поднимает и restoreRest, admin.mjs autoAfter)
        // и, если аккаунт сейчас в прогоне, двигаем его отдых там же.
        try { accounts.setField(acc.id, { floodUntil: new Date(until).toISOString() }); } catch {}
        const ps = auto.per.get(acc.id);
        if (ps) { ps.floodUntil = until; ps.nextAt = Math.max(ps.nextAt || 0, until); }
      } else if (state?.note) {
        // «отлёжка» или «дневной предел» — до завтра тут делать нечего.
        // В «живом дне» спим до утра (суточный счёт к тому времени обнулится):
        // проверять каждые 3–5 часов, не кончилось ли «сегодня», незачем
        s.left = 0;
        s.nextAt = Date.now() + (lively
          ? msUntilEkbHour(LIVELY_FROM) + rnd(0, 40 * 60) * 1000
          : rnd(3 * 3600, 5 * 3600) * 1000);
        s.note = state.note;
      } else if (s.left) {
        const gap = lively ? LIVELY_GAP : WARM_GAP;
        s.nextAt = Date.now() + rnd(gap[0], gap[1]) * 1000;
        s.note = 'сессия идёт';
      } else {
        // «живой день»: сон считаем от остатка действий на сегодня до 23:00
        s.nextAt = Date.now() + (lively ? livelyNap(Number(state?.left))
                                        : rnd(WARM_NAP[0], WARM_NAP[1]) * 1000);
        s.note = 'спит после сессии';
      }
      warmSave();
    });
    launchedBy = 'manual';

    if (r.ok) {
      warmup.lastId = acc.id;
      warmup.fresh = false;
      warmup.pending = '';
      // этот промежуток между пачками своё получил — следующий будет другим
      if (between) st.betweenFor = gapEnd;
    } else {
      st.nextAt = now + 10 * 60_000;      // занят или не вошёл — зайдём позже
      st.note = r.reason || '';
    }
    warmSave();
    if (alone) return;                    // по одному за раз
  }
}

function warmStart() {
  if (warmup.timer) return;
  warmup.on = true;
  warmup.timer = setInterval(warmTick, WARM_TICK);
  push('\n🌱 прогрев поведением включён: аккаунты будут читать, подписываться и переписываться');
  warmSave();
}

function warmStop(why) {
  if (warmup.timer) clearInterval(warmup.timer);
  warmup.timer = null;
  warmup.on = false;
  push(`🌱 прогрев поведением выключен${why ? ': ' + why : ''}`);
  warmSave();
}

/** Человеческая фраза последнего действия прогрева из истории warmup.csv. */
function warmActPhrase(r) {
  const t = (r.target || '').split('#')[0];
  const bad = r.note && r.note !== 'ok' ? ` (${r.note})` : '';
  switch (r.action) {
    case 'sub':   return `подписался на @${t}${bad}`;
    case 'chat':  return `вступил в @${t}${bad}`;
    case 'react': return `почитал ленту, поставил реакцию в @${t}`;
    case 'dm':    return 'написал своему аккаунту';
    case 'bot':   return `запустил бота @${t}`;
    case 'spam':  return 'спросил у SpamBot про лимиты';
    default:      return r.action || '';
  }
}

/* ═══════════ ПРОГРЕВ — что показываем в панели ═══════════ */

/** Что показывать в панели про прогрев. */
function warmView() {
  const now = Date.now();
  return {
    on: warmup.on,
    rotate: warmup.rotate, rotateWait: warmup.rotateWait,
    maxCap: getMaxCap(), plan: getPlan(), checkMax: getCheckMax(),
    warmDays: getWarmDays(),
    between: warmup.between,
    only: warmup.only,
    alone: !ownProxyEach() || !!warmup.rotate,
    accounts: (() => {
      // последнее действие каждого аккаунта из истории — чтобы в паузе было
      // видно, что прогрев реально что-то делал, а не «отдыхает» в пустоту
      const lastAct = new Map();
      for (const r of readCsv('warmup.csv')) lastAct.set(r.account, r);
      return accounts.list().filter((a) => accounts.hasSession(a)).map((a) => {
      const st = warmup.per.get(a.id) || {};
      const rc = running.get(a.id);
      const busy = /Прогрев/.test(rc?.title || '');
      const lr = lastAct.get(a.id);
      const w = warm(a);
      return {
        id: a.id, title: a.title,
        busy,
        // что делает прямо сейчас (живьём из процесса) или сделал в прошлый заход
        act: busy ? (rc?.state?.act || 'работает') : (lr ? warmActPhrase(lr) : (st.act || '')),
        actAt: busy ? 0 : (lr ? (Date.parse(lr.at) || 0) : 0),
        doing: busy && rc?.state?.phase === 'doing',
        wait: Math.max(0, Math.round(((st.nextAt || 0) - now) / 1000)),
        left: st.left || 0, note: st.note || '',
        // сколько по расписанию положено, сколько сегодня осталось,
        // и сколько ещё лежать до старта (для отлёжки)
        day: w.day, dayLeft: w.left, resting: w.resting, restLeft: w.restLeft || 0,
        cap: w.cap, fullDay: w.fullDay,
        // ЕДИНАЯ шкала для всех: общий прогон от покупки до «прогрет» (fullDay суток).
        // Отлёжка — это первые сутки, т.е. первые ~10% полосы, поэтому у лежащих
        // аккаунтов полоса короткая — так и должно быть, они в самом начале.
        pct: w.pct,
        restPct: w.resting ? Math.round((1 - (w.restLeft || 0) / 86400) * 100) : 100,
        spam: a.spam || '', spamOk: a.spamOk !== false, spamAt: a.spamAt || '',
      };
    });
    })(),
  };
}

/* ------------------------------------------------------------- автопрогон
 *
 * Ручной режим — это одна пачка на одно нажатие: нажал, дождался, нажал снова.
 * Автопрогон делает то же самое сам и сразу всеми аккаунтами: каждый берёт
 * свою пачку, отдыхает положенную паузу и берёт следующую, пока база не
 * кончится. Пересечься они не могут — номера делятся бронями (claims), тот же
 * механизм, что и при ручном запуске.
 *
 * Правила, ради которых это вообще отдельный узел:
 *   • один аккаунт — один процесс за раз (профиль Telegram занимает ровно один);
 *   • Telegram придержал аккаунт (PEER_FLOOD, квота) — он уходит отдыхать
 *     на столько, сколько сказала задача, остальные продолжают;
 *   • номер, который не даётся, откладывается после трёх попыток (это делают
 *     сами задачи) — иначе прогон крутился бы на месте;
 *   • дневной предел на аккаунт: сколько сообщений в сутки ему позволено.
 */
const AUTO_TICK = 3000;          // как часто смотрим, кому пора работать
const AUTO_FAILS_MAX = 3;        // столько неудачных запусков — аккаунт выбывает
const AUTO_FAIL_WAIT = 5 * 60;   // после неудачного запуска ждём столько, сек
// Параллель на общем IP: после запуска задачи на прокси следующую на нём же
// пускаем не раньше этого момента. Одного разноса писем мало — подключение,
// /start к SpamBot и импорт контактов у всех иначе шли бы в одну секунду, а
// после каждого перезапуска панели (все nextAt=0) — гарантированно залпом.
const launchHold = new Map();     // прокси -> не запускать на нём раньше, мс
// Письма разных аккаунтов ещё и разводит сама задача (45–90 с, wait_send_gap),
// поэтому старты достаточно не сваливать в одну секунду. 60–120 с на 15.10
// давали «эстафету»: третий аккаунт ждал два чужих слота, ~5 минут.
const LAUNCH_SPREAD = [20, 40];   // разнос запусков на одном прокси, сек
const QUOTA_RETRY = 12 * 3600 * 1000;   // закрытая квота контактов — пробуем снова через столько
const REST_AFTER_LIMIT = 3 * 3600 * 1000;   // после ограничения Telegram (flood) — отлёжка не меньше этого
// сняли ограничение SpamBot — ещё столько без рассылки (догрев), потом письма
// с 2 в сутки; то же число — REST_AFTER_RESTRICTION в tglib.py
const REST_AFTER_RESTRICTION = 3 * 86400 * 1000;
// Как часто аккаунт смотрит ответы. Раньше — раз в 30 минут, и это была
// половина всего трафика прокси: каждый заход тянул 200 диалогов. Лиды
// разбирают руками 2–4 раза в день, поэтому хватает раза в два часа днём;
// надо срочно — кнопка «Проверить ответы сейчас» (/api/funnel/now).
// Кто неделю никому не писал — раз в сутки: ответы на старые письма редки.
const FUNNEL_EVERY = 2 * 3600_000;
const FUNNEL_IDLE_EVERY = 24 * 3600_000;
const FUNNEL_IDLE_AFTER = 7 * 864e5;
const FUNNEL_FROM = 8, FUNNEL_TO = 23;     // часы по Екб, когда проверяем сами
const MAX_TRIES = 3;             // столько же, сколько в check-batch.py и draft-messages.py

const auto = {
  on: false,
  mode: 'full',                  // full | check | write
  funnel: false,                 // слать второе письмо тем, кто ответил
  serial: false,                 // работать по очереди, а не всеми сразу
  rotate: '',                    // ссылка на смену IP у мобильного прокси
  rotateWait: 10,                // сколько ждать, пока модем поднимет новый IP
  fresh: false,                  // IP уже сменили — можно работать
  holdUntil: 0,                  // до этого времени никого не запускаем
  rotateFails: 0,
  send: false, voice: false,
  warm: true,                    // беречь новые аккаунты по расписанию прогрева
  check: { limit: 20, delay: 15 },
  write: { limit: 2,  delay: 5  },
  pause: 60,                     // между своими пачками, сек
  ids: [],                       // кто участвует
  per: new Map(),                // id -> { nextAt, note, batches, fails, stopped }
  timer: null, since: 0,

  /**
   * «По номерам» и «по чатам» — два независимых режима: у каждого свой список
   * аккаунтов и свои настройки рассылки. Один и тот же аккаунт в двух режимах
   * сразу не работает — набор у него один.
   *
   * Общее у режимов одно, зато главное: ПРОКСИ. Поэтому очередь запусков,
   * работа по одному за раз и смена IP остаются общими на оба — иначе два
   * режима удвоили бы нагрузку на один адрес, за что Telegram и наказывает.
   */
  live: { phones: false, chats: false },   // какие режимы сейчас работают
  sets: new Map(),                         // id -> набор, по которому идёт аккаунт
  opts: { phones: null, chats: null },     // настройки каждого режима
};

/** По какому набору работает аккаунт и с какими настройками. */
const setOf = (id) => auto.sets.get(id) || baseSet;
const optOf = (id) => auto.opts[setOf(id)] || auto;
/** Кто из прогона идёт по этому набору. */
const idsOfSet = (set) => auto.ids.filter((id) => setOf(id) === set);

// минуты считаем от общего числа, а не от остатка часов: иначе выходит
// «23 ч 60 мин» — и неправда, и строка скачет на каждом опросе
const fmtLeft = (sec) => {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
};
const hhmm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
/**
 * Число из формы: пустое поле — это «не задано», а не ноль.
 *
 * Раньше пустая строка превращалась в ноль (Number('') === 0) и зажималась в
 * минимум: очистил «сек между письмами» — и аккаунт начинал писать раз в 3
 * секунды вместо 180, очистил «писем за заход» — и уходило по одному письму.
 * Молчаливая подмена в самую опасную сторону: минимум здесь — это максимум
 * скорости. Теперь пустое (и null/undefined) берёт значение по умолчанию,
 * а ноль, введённый руками, по-прежнему зажимается в минимум.
 */
const num = (v, d, min, max) => {
  const s = String(v ?? '').trim();
  if (!s) return d;
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/**
 * Сколько работы осталось на самом деле: занятые брони не в счёт (их уже
 * кто-то делает), безнадёжные номера — тоже.
 */
function work(set = baseSet) {
  const held = claims.heldAll();
  const base = readCsv('numbers.csv', set);
  const res = readCsv('results.csv', set);
  const log = readCsv('drafts.csv', set);

  const checked = new Set(res.filter((r) => ['true', 'false', 'idle'].includes(r.tg)).map((r) => r.phone));
  const tries = {};
  for (const r of res) if (!checked.has(r.phone)) tries[r.phone] = (tries[r.phone] || 0) + 1;
  const check = base.filter((r) => isPhone(r.phone) && !checked.has(r.phone)
    && (tries[r.phone] || 0) < MAX_TRIES && !held.has(r.phone)).length;

  // skip — давно не заходил в Telegram: с ним тоже всё решено
  const written = new Set(log.filter((r) => r.ok === 'true' || r.ok === 'skip' || r.sent === 'true').map((r) => r.phone));
  const dtries = {};
  for (const r of log) if (!written.has(r.phone)) dtries[r.phone] = (dtries[r.phone] || 0) + 1;
  // «только лиды»: остальные люди из чатов этому режиму не работа
  const leadKeys = enrich.leadKeys();
  const onlyLeads = set === 'chats' && !!auto.opts.chats?.leadsOnly;
  const free = res.filter((r) => r.tg === 'true' && !written.has(r.phone)
    && (dtries[r.phone] || 0) < MAX_TRIES && !held.has(r.phone)
    && (!onlyLeads || leadKeys.has(r.phone)));

  /**
   * Кому может написать любой аккаунт, а кому — только один.
   *
   * Номер и @username доступны всем: их делят брони, и рассылка идёт всеми
   * аккаунтами сразу. А человека без @username (ключ id:<id>) видит только тот
   * аккаунт, который его нашёл, — access_hash к нему живёт в его сессии.
   * Поэтому таких считаем отдельно, за их владельцем: если записать их в общую
   * кучу, прогон будет вечно видеть работу, которой другим не сделать.
   */
  // kept=1 — человек лежит в контактах проверившего аккаунта: пишет только он
  const own = {};
  let shared = 0;
  for (const r of free) {
    // лид обогащения без @username — общий: любой писатель найдёт его через
    // сохранённое сообщение в чате (draft-messages.find_member)
    const solo = String(r.phone).startsWith('id:') && !(r.by === 'lead' && leadKeys.has(r.phone));
    if (solo || r.kept === '1') own[r.by] = (own[r.by] || 0) + 1;
    else shared++;
  }

  return { check, write: free.length, shared, own };
}

/** До начала следующих суток — столько ждёт аккаунт, выбравший дневной предел. */
const untilTomorrow = () => {
  const d = new Date();
  d.setHours(24, 5, 0, 0);
  return d.getTime();
};

/**
 * Писать людям — только в рабочее время по их часам. База екатеринбургская,
 * а сервер живёт по UTC: без явного пояса «с 6 утра» наступало бы в 11 по
 * Екатеринбургу, а ночные сообщения — лучший способ собрать жалобы на спам.
 * Проверка номеров никому не пишет, её ночь не останавливает.
 */
const WORK_FROM = 6;     // с 06:00
const WORK_TO = 24;      // до полуночи
const workHour = () => Number(new Intl.DateTimeFormat('en-GB',
  { timeZone: WORK_TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const isWorkTime = () => { const h = workHour(); return h >= WORK_FROM && h < WORK_TO; };
/**
 * Когда откроется рабочее окно. Ночью аккаунту нельзя писать, но это НЕ значит,
 * что его день кончился: утром он допишет своё. Если усыпить его «до завтра»,
 * он проспит и весь завтрашний день до полуночи — ровно это и случилось.
 */
const untilWorkStart = () => {
  const h = workHour();
  if (h >= WORK_FROM && h < WORK_TO) return Date.now();
  const wait = h < WORK_FROM ? WORK_FROM - h : 24 - h + WORK_FROM;
  const d = new Date();
  d.setMinutes(0, 0, 0);                       // часовые пояса здесь ровные
  return d.getTime() + wait * 3600_000 + 5 * 60_000;
};
let nightNoted = '';     // о ночи пишем в ленту раз за ночь, а не на каждом тике

/** Одна и та же новость про аккаунт — в журнал раз в сутки, а не на каждом заходе. */
function notedOnce(s, kind) {
  const day = new Date().toISOString().slice(0, 10);
  s.noted = s.noted || {};
  if (s.noted[kind] === day) return false;
  s.noted[kind] = day;
  return true;
}

/** Чем занять этот аккаунт прямо сейчас. null — пока нечем. */
function funnelJob(id) {
  const o = optOf(id);
  // Проверку ответов делаем ВСЕГДА, даже без второго шага — иначе на наборе
  // без воронки не копилась бы статистика ответов и нечем было бы работать
  // руками. Второе письмо при этом не уходит (см. send при запуске задачи).
  if (o.mode === 'check') return null;
  const s = auto.per.get(id);
  // «проверить сейчас» из панели — без окна по часам; сами — только днём
  if (!s.funnelNow) {
    const h = workHour();
    if (!isWorkTime() || h < FUNNEL_FROM || h >= FUNNEL_TO) return null;
  }
  const every = Date.now() - lastWroteAt(id) > FUNNEL_IDLE_AFTER ? FUNNEL_IDLE_EVERY : FUNNEL_EVERY;
  // первый раз после запуска панели — от последней настоящей проверки этого
  // аккаунта (её пишет followup.py в followup-runs.json). Раньше бралось
  // случайное время до часа, и частые перезапуски откладывали проверку ответов
  // бесконечно. Просрочено — разносим аккаунты на несколько минут, чтобы не
  // встали в очередь все разом перед первой же пачкой писем
  if (!s.funnelAt) {
    let last = 0;
    try { last = Date.parse(JSON.parse(fs.readFileSync(path.join(DIR, 'followup-runs.json'), 'utf8'))?.[id]?.at) || 0; } catch {}
    s.funnelAt = Math.max(last + every, Date.now() + Math.random() * 5 * 60_000);
  }
  if (Date.now() < s.funnelAt) return null;
  s.funnelAt = Date.now() + every;
  s.funnelNow = false;
  return { name: 'follow', limit: 2, delay: o.write.delay, delayMax: o.write.delayMax };
}


function pickJob(left, id) {
  const acc = accounts.list().find((a) => a.id === id);
  // набор и настройки — того режима, в котором этот аккаунт работает
  const set = setOf(id);
  const o = optOf(id);
  // «только прогрев»: новых писем и проверок нет, но на ответы тем, кому
  // аккаунт писал раньше, он отвечает — человек не должен ждать
  if (acc && !accounts.inOutreach(acc)) return wroteAny().has(id) ? funnelJob(id) : null;
  // квота Telegram на добавление контактов кончилась — до её возврата ни
  // проверки, ни письма по номеру (оба начинаются с «добавить в контакты»).
  // Отметка лежит в аккаунте и переживает перезапуск панели: иначе после
  // каждого перезапуска аккаунт снова ломился бы в закрытую квоту
  const quotaOut = !!acc?.quotaUntil && Date.now() < Date.parse(acc.quotaUntil);
  // срок ожидания квоты прошёл — первую проверку по номерам делаем одним
  // номером: вернулась квота или нет
  const quotaProbe = !!acc?.quotaUntil && !quotaOut;

  // Пока рассылка идёт ПО ЧАТАМ, номера не трогаем вовсе.
  //
  // Раньше тут была проба: срок ожидания квоты прошёл — спросим один номер,
  // вернулась ли она. Но проба — это добавление контакта, ровно та операция,
  // за которую Telegram и ограничивает аккаунты. По чатам пишут по @нику, и
  // квота для этой работы не нужна совсем: тратить на неё риск незачем.
  // Квота проверится сама, когда рассылку переключат обратно на номера —
  // первая же проверка покажет, открылась она или нет.
  // людям из чатов пишем по @нику — контакты не добавляются, квота не мешает
  const canWrite = o.mode !== 'check' && isWorkTime() && (!quotaOut || set === 'chats');
  // Проверка номеров — только когда работаем ПО НОМЕРАМ. По чатам людям пишут
  // по @нику, проверять там нечего, а каждая проверка — это добавление
  // контакта, то самое действие, за которое Telegram ограничивает аккаунты.
  //
  // И только пока на сегодня есть что написать. Выбрал дневной предел — день
  // для аккаунта кончился целиком: проверять «про запас» он не идёт. Проверка
  // стоит ровно того же, что письмо (добавление контакта), а лежать в адресной
  // книге до завтра найденному незачем.
  // дневной потолок считаем ВСЕГДА (даже если «беречь аккаунты» выключено) —
  // иначе один тумблер снимает всю защиту от бана. Галка лишь отключает отлёжку.
  const w = acc ? warm(acc) : null;
  const capLeftNow = w ? w.left : Infinity;      // сколько писем осталось сегодня
  // Ночью не проверяем тоже. Проверок в сутки теперь столько же, сколько писем:
  // потратив их ночью «про запас», аккаунт остался бы днём без проверок —
  // а днём он как раз и должен проверять номер и сразу писать найденному.
  // Режим «только проверять» — исключение: писем там нет, ночь не мешает.
  const canCheck = o.mode !== 'write' && !quotaOut && set === 'phones'
    && (o.mode === 'check' || (capLeftNow > 0 && isWorkTime()));

  // отлёжка: свежий аккаунт сутки не делает вообще ничего — ни проверок,
  // ни сообщений. Это единственный способ не потерять его в первый же день.
  // Значение берём у СВОЕГО режима (auto.opts[set].warm): у «по номерам» и
  // «по чатам» настройка независимая, и снятая галочка на одной вкладке больше
  // не снимает отлёжку аккаунтам другого, уже идущего прогона.
  if (o.warm !== false && w && w.resting) {
    const s = auto.per.get(id);
    if (s && s.note !== 'отлёжка') {
      s.note = 'отлёжка';
      s.nextAt = Date.now() + Math.min(w.restLeft, 3600) * 1000;
      push(`⏸ «${title(id)}» на отлёжке — ${fmtLeft(w.restLeft)} до первой работы`);
    }
    return null;
  }

  /**
   * Второй шаг воронки идёт вперёд первого: человек уже ответил и ждёт, а
   * тянуть с ответом — значит терять того единственного, кто откликнулся.
   * Сколько таких, панель заранее не знает: это видно только из диалогов,
   * поэтому просто зовём задачу, а она сама скажет, было кому писать или нет.
   */
  // ответы смотрим и тогда, когда квота на контакты кончилась или письма на
  // сегодня выбраны: проверка ответов контакты не добавляет, а человек,
  // сказавший «да», не должен ждать ссылку до завтра
  const fj = funnelJob(id);
  if (fj) return fj;

  // сколько работы есть именно у этого аккаунта: общая очередь плюс его
  // собственные люди из чатов, которых больше никто написать не может
  const canDo = left.shared + (left.own[id] || 0);
  if (canWrite && canDo > 0) {
    // дневной предел один — из графика разгона с общим «максимумом в день»
    const capLeft = capLeftNow;
    if (capLeft > 0) {
      return { name: 'drafts',
               limit: Math.max(1, Math.min(o.write.limit, canDo, capLeft)),
               delay: o.write.delay, delayMax: o.write.delayMax,
               hold: o.write.hold, holdMax: o.write.holdMax };
    }
    const s = auto.per.get(id);
    if (s) {
      s.note = 'дневной предел';
      // со вторым шагом — вернёмся к очередной проверке ответов, без него — завтра
      s.nextAt = o.funnel ? Math.max(Date.now() + 60_000, s.funnelAt || 0) : untilTomorrow();
      if (notedOnce(s, 'cap')) push(`⏸ «${title(id)}» выбрал дневной предел (${w ? w.cap : '—'}) — вернётся завтра`);
    }
  }
  // проверка оставляет найденных в контактах аккаунта до письма — поэтому
  // не проверяем впрок: хватит очереди на два дня писем. Иначе адресная
  // книга распухла бы чужими номерами, а это примета для антиспама
  // проверяем не впрок, а под сегодняшние письма: сколько ещё можно написать
  // сегодня — столько людей и нужно найти. Найденный остаётся в контактах, и
  // следующим же заходом аккаунт ему пишет
  const backlogMax = Math.max(1, w ? w.left : 1);
  const backlogFull = (left.own[id] || 0) >= backlogMax;
  if (canCheck && left.check > 0 && backlogFull) {
    const s = auto.per.get(id);
    if (s && !(canWrite && canDo > 0) && s.note !== 'очередь писем полна') {
      s.note = 'очередь писем полна';
      s.nextAt = Date.now() + 30 * 60_000;
    }
  }
  if (canCheck && left.check > 0 && !backlogFull) {
    const c = checksOf(id);
    if (c.left > 0) {
      if (quotaProbe) return { name: 'check', limit: 1, delay: o.check.delay, probe: true };
      // Если писать сегодня ещё можно — берём РОВНО ОДИН номер: нашли живого,
      // следующим шагом сразу ему пишем, и только потом берём следующий номер.
      // Так найденный не лежит в адресной книге и не ждёт своей пачки.
      // Пачкой проверяем лишь когда писать нельзя (режим «только проверять»,
      // ночь, выбран дневной предел) — тогда очередь готовится заранее.
      if (canWrite && capLeftNow > 0) {
        return { name: 'check', limit: 1, delay: o.check.delay, step: true };
      }
      // в Telegram находится ~70% номеров — пачку берём по свободному месту в очереди
      const room = Math.max(1, Math.ceil((backlogMax - (left.own[id] || 0)) / 0.7));
      return { name: 'check', limit: Math.min(o.check.limit, left.check, c.left, room), delay: o.check.delay };
    }
    const s = auto.per.get(id);
    // и писать нечего/нельзя, и проверки на сегодня кончились — до завтра
    // (со вторым шагом — до очередной проверки ответов)
    if (s && !(canWrite && canDo > 0)) {
      s.note = 'проверки на сегодня';
      s.nextAt = o.funnel ? Math.max(Date.now() + 60_000, s.funnelAt || 0)
               : isWorkTime() ? untilTomorrow() : untilWorkStart();
      if (notedOnce(s, 'checks')) push(`⏸ «${title(id)}» проверил на сегодня ${c.today} из ${c.cap} номеров — продолжит завтра`);
    }
  }
  // Дневной предел выбран, а работы для него сегодня и не было (очередь писем
  // пуста): без этого аккаунт висел бы с пустой пометкой и «ждёт своей
  // очереди», хотя на сегодня он уже всё.
  if (canWrite && capLeftNow <= 0) {
    const s = auto.per.get(id);
    if (s && s.note !== 'дневной предел') {
      s.note = 'дневной предел';
      s.nextAt = o.funnel ? Math.max(Date.now() + 60_000, s.funnelAt || 0) : untilTomorrow();
    }
    return null;
  }

  if (o.mode !== 'check' && !isWorkTime()) {
    const s = auto.per.get(id);
    if (s) {
      s.note = `ночь — пишем с ${WORK_FROM}:00 по Екатеринбургу`;
      s.nextAt = Math.max(s.nextAt || 0, untilWorkStart());
    }
    const night = new Date().toISOString().slice(0, 10);
    if (nightNoted !== night) {
      nightNoted = night;
      events.note('🌙', `ночь — до ${WORK_FROM}:00 по Екатеринбургу ничего не делаем: ни писем, ни проверок`);
    }
  }
  return null;
}

const title = (id) => accounts.list().find((a) => a.id === id)?.title || id;

/**
 * Смена IP на мобильном прокси.
 *
 * У мобильных прокси один адрес на всех, зато его можно менять по ссылке из
 * личного кабинета. Отсюда и режим «по очереди»: аккаунты работают не разом,
 * а один за другим, и между ними панель просит модем сменить IP. Толку от
 * смены не было бы, работай они параллельно — они всё равно сидели бы на одном
 * адресе одновременно.
 *
 * После запроса ждём: оператору нужно несколько секунд, чтобы физически поднять
 * соединение заново. Начать работать сразу — значит пойти со старого адреса.
 */
const ROTATE_TIMEOUT = 15000;
const ROTATE_FAILS_MAX = 3;

function rotateUrlProblem(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return 'ссылка на смену IP не похожа на ссылку'; }
  if (!/^https?:$/.test(u.protocol)) return 'ссылка должна быть http или https';
  // 169.254.169.254 — служебный адрес облака, через него у провайдера
  // выпрашивают ключи от самого сервера. Ходить туда панели незачем
  if (/^169\.254\./.test(u.hostname)) return 'это служебный адрес облака, а не прокси';
  return '';
}

/**
 * Не чаще, чем раз в столько, дёргаем смену IP.
 *
 * Прогрев меняет адрес перед каждым переходом на другой аккаунт, а аккаунтов
 * два десятка — модем переключался каждые несколько минут. Каждое
 * переключение это секундный обрыв: сторож объявляет прокси лежащим, задачи
 * не стартуют, лента забита «прокси лежит». Смысл ротации — чтобы соседние
 * аккаунты не светились с одного адреса, и он сохраняется: просто подряд
 * идущие заходы в пределах этого окна делят один IP.
 */
const ROTATE_MIN_GAP = 12 * 60_000;
let lastRotateAt = 0;
const rotatedRecently = () => Date.now() - lastRotateAt < ROTATE_MIN_GAP;

async function rotateIp(url) {
  lastRotateAt = Date.now();
  const bad = rotateUrlProblem(url);
  if (bad) return { ok: false, reason: bad };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ROTATE_TIMEOUT) });
    const text = (await r.text()).trim().slice(0, 200);
    return { ok: r.ok, code: r.status, text,
             reason: r.ok ? '' : `прокси ответил ${r.status}` };
  } catch (e) {
    if (e.name === 'TimeoutError') return { ok: false, reason: 'прокси не ответил за 15 секунд' };
    // fetch прячет настоящую причину внутрь cause, а наружу отдаёт
    // бесполезное «fetch failed» — человеку от него никакого толку
    const why = e.cause?.code || e.cause?.message || e.message || '';
    return { ok: false, reason: 'не достучались до прокси' + (why ? `: ${why}` : '') };
  }
}

/** Смена IP внутри прогона: результат идёт в журнал, дальше пауза. */
async function rotateForRun() {
  auto.holdUntil = Date.now() + ROTATE_TIMEOUT;   // пока идёт запрос — никого не пускаем
  push('\n🔄 меняю IP на прокси…');
  const r = await rotateIp(auto.rotate);
  if (!auto.on) return;
  if (r.ok) {
    auto.rotateFails = 0;
    auto.fresh = true;
    auto.holdUntil = Date.now() + auto.rotateWait * 1000;
    push(`   прокси ответил: ${r.text || 'ок'} — жду ${auto.rotateWait} с, пока поднимется новый адрес`);
    return;
  }
  if (!(await proxyGuard.check(proxyOf(auto.ids[0])))) {
    auto.holdUntil = Date.now() + 60_000;
    push(`   ✗ сменить IP не вышло: ${r.reason} — прокси сейчас лежит, жду, пока поднимется`);
    return;
  }
  auto.rotateFails++;
  push(`   ✗ сменить IP не вышло: ${r.reason} (попытка ${auto.rotateFails} из ${ROTATE_FAILS_MAX})`);
  if (auto.rotateFails >= ROTATE_FAILS_MAX) {
    // работать дальше — значит слать всё с одного адреса, ради смены которого
    // режим и включали. Лучше честно остановиться
    autoStop('прокси не меняет IP — дальше слать с одного адреса опаснее, чем встать');
    return;
  }
  auto.holdUntil = Date.now() + 60_000;
}

/** Раз в несколько секунд: кому пора работать — того и запускаем. */
function autoTick() {
  if (!auto.on) return;
  if (manualHold()) return;
  const now = Date.now();
  // срок ограничения прошёл — аккаунт возвращается в рассылку сам
  for (const id of auto.ids) {
    const s = auto.per.get(id);
    const acc = accounts.list().find((a) => a.id === id);
    if (s?.stopped && s.quarantine && acc && !inQuarantine(acc)) {
      Object.assign(s, { stopped: false, quarantine: false, note: '', nextAt: 0, fails: 0 });
      // сразу писать незнакомым не идём: сначала отдых без рассылки (если бот
      // уже сказал «свободен», его поставил tglib.spam_check), потом разгон с 2/день
      if (!accounts.sendHoldLeft(acc)) {
        accounts.setField(id, { sendHoldUntil: new Date(now + REST_AFTER_RESTRICTION).toISOString() });
      }
      const holdTo = Date.parse(accounts.list().find((a) => a.id === id)?.sendHoldUntil || '') || now;
      events.note('✅', `ограничение Telegram снято — до ${ekbDateTime(holdTo)} по Екб без рассылки ` +
        '(лёгкий догрев), потом письма заново с 2 в день', acc.title);
    }
  }
  const byId = new Map(accounts.list().map((a) => [a.id, a]));
  const live = auto.ids.filter((id) => !auto.per.get(id).stopped && byId.has(id));
  // аккаунты на прогреве в прогоне только разбирают ответы — прогон держат те, кто пишет
  const senders = live.filter((id) => accounts.inOutreach(byId.get(id)));
  if (!senders.length) return autoStop('в рассылке не осталось аккаунтов — смотри журнал');
  // прокси лежит — ни смены IP, ни запусков: они только копили бы сбои
  if (live.every((id) => proxyGuard.down(proxyOf(id)))) return;

  // Остаток работы считаем ОТДЕЛЬНО по каждому работающему режиму: у номеров
  // и у чатов свои файлы, своя очередь и свой конец.
  const lefts = {};
  for (const set of SETS) if (auto.live[set]) lefts[set] = work(set);
  const busy = live.some((id) => running.has(id)) || accessBusy.size > 0;

  // Режим заканчивается сам по себе: его база пройдена и его аккаунты
  // свободны. Второй при этом продолжает — они друг от друга не зависят.
  for (const set of SETS) {
    if (!auto.live[set] || !lefts[set]) continue;
    const mine = senders.filter((id) => setOf(id) === set);
    if (!mine.length) { finishSet(set, 'в нём не осталось аккаунтов'); continue; }
    if (mine.some((id) => running.has(id) || accessBusy.has(id))) continue;
    const l = lefts[set];
    const o = auto.opts[set] || auto;
    // работа, которую МОГУТ сделать оставшиеся: людей, доступных только
    // выбывшему аккаунту, ждать бессмысленно
    const canWrite = l.shared + mine.reduce((n, id) => n + (l.own[id] || 0), 0);
    const need = o.mode === 'check' ? l.check
               : o.mode === 'write' ? canWrite : l.check + canWrite;
    if (!need) {
      finishSet(set, o.mode === 'check' ? 'база пройдена'
                   : o.mode === 'write' ? 'всем найденным написано'
                   : 'база пройдена, всем найденным написано');
    }
  }
  if (!auto.on) return;

  /**
   * Режим «по очереди»: работает ровно один аккаунт за раз, и перед каждым
   * панель меняет IP на прокси. Нужен, когда прокси один на всех (мобильный
   * с ротацией): параллельно они сидели бы на одном адресе, и смена его
   * ничего бы не дала.
   */
  if (auto.serial) {
    if (busy) return;                       // кто-то ещё работает — ждём его
    if (now < auto.holdUntil) return;       // модем поднимает новый адрес
    // Сама смена IP перенесена ниже, к запуску задачи: менять адрес стоит
    // только перед той работой, которая аккаунт действительно светит.
  }

  // По очереди работает кто-то один, поэтому порядок решает: без него первые
  // в списке забирали бы заход за заходом, а последние ждали бы, пока у первых
  // кончится дневной предел. Пускаем того, кто дольше всех не работал.
  // Снятые за ограничение Telegram не пишут, но ответы на прежние письма читать
  // можно и нужно: иначе «да» такому аккаунту ждало бы конца ограничения (у a9
  // 16.10 — месяц), и никто бы его не увидел. Им — только «смотрит ответы», в конце очереди
  const held = auto.ids.filter((id) => auto.per.get(id)?.stopped && auto.per.get(id).quarantine && byId.has(id));
  const queue = (auto.serial
    ? [...live].sort((x, y) => (auto.per.get(x)?.lastAt || 0) - (auto.per.get(y)?.lastAt || 0))
    : live).concat(held)
    // Режим мог закончиться прямо в этом же тике — finishSet() выше удаляет его
    // аккаунты из auto.per и гасит auto.live[набор]. В `live` они ещё лежат
    // (список снят раньше), и раньше это роняло весь тик: сортировка очереди по
    // «кто дольше не работал» читала auto.per.get(x).lastAt у уже удалённого
    // аккаунта. Наружу это выглядело так: запуск второго режима (по чатам, когда
    // уже идут номера) отвечал ошибкой «Cannot read properties of undefined» —
    // ровно в тот момент, когда второй набор оказывался пустым и завершался сам.
    .filter((id) => auto.per.has(id) && auto.live[setOf(id)]);
  // параллель на общем IP — запуски разводим по времени (см. launchHold)
  const spread = !auto.serial && !ownProxyEach();

  for (const id of queue) {
    if (running.size >= MAX_RUNNING) break;      // потолок одновременных задач (см. MAX_RUNNING)
    if (running.has(id) || accessBusy.has(id)) continue;
    if (proxyGuard.down(proxyOf(id))) continue;
    // полный отдых после заморозки: ни писем, ни «смотрит ответы» — ни одного
    // подключения. «Без рассылки» сюда не относится: писем ему и так не дадут
    // (inOutreach), а посмотреть ответы на прежние письма можно
    if (accounts.fullRestLeft(byId.get(id))) continue;
    const pkey = proxyOf(id) || 'direct';
    if (spread && now < (launchHold.get(pkey) || 0)) continue;   // возьмётся следующим тиком
    const s = auto.per.get(id);
    const set = setOf(id);
    const left = lefts[set];
    const o = auto.opts[set] || auto;
    if (!left) continue;            // режим этого аккаунта уже закончил работу
    let job;
    if (s.stopped) {
      if (!wroteAny().has(id)) continue;
      job = funnelJob(id);
      if (!job) continue;
    } else if (now < s.nextAt) {
      // отдыхает между пачками писем — но посмотреть, ответили ли ему, можно:
      // это чтение диалогов, а не рассылка. Отдых при этом не сбивается (autoAfter)
      if (!wroteAny().has(id)) continue;
      job = funnelJob(id);
      if (!job) continue;
      s.restUntil = s.nextAt;
    } else {
      job = pickJob(left, id);
      if (!job) continue;
    }
    // то, что забрал этот аккаунт, не должно достаться ещё и следующему
    // в этом же обходе: иначе на два оставшихся номера уйдёт пять пачек
    if (job.name === 'drafts') {
      // сначала списываем со своих: их всё равно никто другой не возьмёт
      const fromOwn = Math.min(job.limit, left.own[id] || 0);
      left.own[id] = (left.own[id] || 0) - fromOwn;
      left.shared = Math.max(0, left.shared - (job.limit - fromOwn));
      left.write -= job.limit;
    } else left.check -= job.limit;

    /**
     * Смена IP — только перед письмами и проверкой номеров.
     *
     * Каждая смена уводит модем из сети примерно на минуту: в журнале это
     * «прокси лежит», и прогон на это время встаёт. Поэтому платить за неё
     * стоит там, где аккаунт реально светится — пишет людям или добавляет
     * контакты. Чтение своих же диалогов («смотрит ответы») адрес не пачкает,
     * а идёт оно у каждого аккаунта раз в полчаса: на нём и уходило
     * большинство смен.
     */
    if (auto.serial && auto.rotate && !auto.fresh && !rotatedRecently()
        && (job.name === 'drafts' || job.name === 'check')) {
      rotateForRun();
      return;                       // этот же аккаунт пойдёт следующим заходом
    }

    s.probe = !!job.probe;          // пробный заход «вернулась ли квота»
    s.jobName = job.name;           // чем аккаунт был занят — это решает длину отдыха
    s.jobStep = !!job.step;         // шаг цепочки «проверил → написал», а не отдельная пачка
    s.jobSet = set;                 // по какому набору шла задача: по чатам контакты не добавляются
    launchedBy = 'auto';
    const r = start(job.name, {
      account: id, limit: job.limit, delay: job.delay, set,
      delayMax: job.delayMax, hold: job.hold, holdMax: job.holdMax,
      // «беречь новые аккаунты» — у каждого режима своё (см. auto.opts[set].warm)
      warm: o.warm !== false,
      // параллель с одного IP: без разноса аккаунты уходят залпом в одну
      // секунду (14.10 так и было) — по очереди этого не бывает
      sendGap: job.name === 'drafts' && !auto.serial && !ownProxyEach(),
      // второе письмо — это всегда отправка: черновиком ссылку не оставишь,
      // человек уже ответил и ждёт
      // второе письмо (follow) уходит только при включённом втором шаге;
      // без него «Смотрит ответы» просто фиксирует ответы, ничего не отправляя
      send: o.send && !o.voice && (job.name === 'drafts'
        || (job.name === 'follow' && o.funnel && !s.stopped && !accounts.sendHoldLeft(byId.get(id)))),
      voice: job.name === 'drafts' && o.voice,
      leadsOnly: job.name === 'drafts' && set === 'chats' && !!o.leadsOnly,
    }, (code, st) => autoAfter(id, code, st));
    launchedBy = 'manual';

    if (r.ok) {
      if (!s.stopped) s.note = '';
      s.lastAt = now;
      // по очереди — значит один за раз: следующего позовём, когда этот
      // закончит и панель снова сменит IP
      if (auto.serial) { auto.fresh = false; return; }
      // слот занимают только задачи, что пишут людям или заводят контакты;
      // «смотрит ответы» лишь читает диалоги — из-за неё ждал бы следующий
      if (spread && (job.name === 'drafts' || job.name === 'check')) {
        launchHold.set(pkey, now + rnd(LAUNCH_SPREAD[0], LAUNCH_SPREAD[1]) * 1000);
      }
      continue;
    }
    // не запустилась проверка ответов посреди отдыха — сбоем не считаем и отдых
    // не режем: иначе ниже nextAt стал бы «через 5 минут» и сон между порциями
    // писем (40–60 мин) обрывался бы на первом же тике
    if (s.restUntil) {
      s.nextAt = Math.max(s.nextAt, s.restUntil);
      s.restUntil = 0;
      continue;
    }
    // не запустилось (нет сессии, аккаунт занят чужой задачей) — не долбимся
    s.fails++;
    s.note = r.reason || 'не запускается';
    if (s.fails >= AUTO_FAILS_MAX) {
      s.stopped = true;
      push(`⏹ «${title(id)}» выбывает из автопрогона: ${s.note}`);
    } else {
      s.nextAt = now + AUTO_FAIL_WAIT * 1000;
    }
  }
}

/** Задача упала, а прокси жив — значит, дело в аккаунте: считаем сбой. */
function autoFail(id, s) {
  s.fails++;
  if (s.fails >= AUTO_FAILS_MAX) {
    s.stopped = true;
    s.note = 'задача падает — смотри журнал';
    push(`⏹ «${title(id)}» выбывает из автопрогона: ${AUTO_FAILS_MAX} неудачных запуска подряд`);
  } else {
    s.nextAt = Date.now() + AUTO_FAIL_WAIT * 1000;
    s.note = 'сбой, пробую снова';
  }
}

/** Пачка кончилась: решаем, когда звать этот аккаунт снова. */
function autoAfter(id, code, st) {
  const s = auto.per.get(id);
  if (!s || !auto.on) return;
  // снятый за ограничение только смотрел ответы — его отдых и отметки не трогаем
  if (s.stopped && s.quarantine) return;
  const o = optOf(id);
  const now = Date.now();
  // задача была проверкой ответов посреди отдыха: что бы ни случилось, отметку снимаем
  const restUntil = s.restUntil || 0;
  s.restUntil = 0;

  // задача сама сообщила о карантине — снимаем аккаунт до завтра
  if (st?.stop === 'quarantine') {
    s.stopped = true;
    s.quarantine = true;      // временное снимется по сроку; заморозка — пока не разбанят
    const frozen = accounts.list().find((a) => a.id === id)?.spamKind === 'frozen';
    s.note = frozen ? 'аккаунт заморожен' : 'ограничение Telegram';
    push(frozen
      ? `⛔ «${title(id)}» ЗАМОРОЖЕН Telegram (блокировка по жалобам) — снят с рассылки, нужен разбан через @SpamBot`
      : `⏹ «${title(id)}» снят с рассылки: на нём ограничение Telegram`);
    return;
  }

  // пробный номер не прошёл — квота всё ещё закрыта, даже если задача не
  // успела объявить «квота кончилась» (ей для этого нужно несколько отказов)
  if (s.probe && !st?.stop && !(st?.done > 0) && code === 0) st = { ...st, stop: 'quota', cooldown: 1 };
  if (st?.stop && st.cooldown) {
    // Telegram придержал аккаунт — отдых ровно на столько, сколько он просит
    s.nextAt = now + st.cooldown * 1000;
    if (st.stop === 'quota') {
      // Telegram не говорит, когда квота вернётся. Сутки ждать нет смысла:
      // через 12 часов пробуем один номер, не вышло — ещё 12 часов
      const until = now + QUOTA_RETRY;
      accounts.setField(id, { quotaUntil: new Date(until).toISOString() });
      // по чатам пишем по @нику, квота тут не нужна — аккаунт не усыпляем,
      // откладываем только следующую пробу квоты
      s.nextAt = s.jobSet === 'chats' ? now + 60_000 : until;
      events.note('⏳', `квота Telegram на добавление контактов закрыта — пробую одним номером в ${ekbTime(until)} по Екб, ` +
        `через ${fmtLeft(QUOTA_RETRY / 1000)}` + (s.jobSet === 'chats'
          ? ' (по чатам продолжает писать — там контакты не нужны)' : ' (пока ответы смотрим и догреваемся)'), title(id));
    }
    // после ограничения Telegram (FloodWait/PEER_FLOOD) — отлёжка не меньше 3
    // часов: короткий FloodWait и повтор «в лоб» часто ведут к новому
    // ограничению, даже когда пишешь целевым. Квоту и карантин не трогаем —
    // у них своя логика (12 ч / 24 ч).
    if (st.stop === 'flood') s.nextAt = Math.max(s.nextAt, now + REST_AFTER_LIMIT);
    // задача шла посреди отдыха (проверка ответов) — отдых не укорачиваем
    if (restUntil) s.nextAt = Math.max(s.nextAt, restUntil);
    // отлёжку после флуда помним отдельно от s.note (его перетирают проверки
    // ответов): догрев между пачками в это время не трогает аккаунт
    if (st.stop === 'flood') {
      s.floodUntil = s.nextAt;
      // и в реестр: состояние прогона живёт в памяти, а отдых после флуда (3–12 ч)
      // должен пережить «Остановить → Запустить» и перезапуск панели (restoreRest)
      accounts.setField(id, { floodUntil: new Date(s.nextAt).toISOString() });
    }
    s.note = st.stop === 'quota' ? 'квота на сегодня'
           : st.stop === 'flood' ? 'придержан Telegram за рассылку'
           : st.stop === 'hold' ? 'отдых после ограничения'
           : st.stop === 'text' ? 'ошибка в тексте письма' : 'сбои подряд';
    s.fails = 0;
    push(`⏸ «${title(id)}» отдыхает до ${hhmm(s.nextAt)} — ${s.note}`);
    return;
  }
  if (code !== 0) {
    // задача упала, итога не прислала: сеть, мёртвая сессия, прокси.
    // Сначала спрашиваем сторожа: если лёг прокси, аккаунт ни при чём
    proxyGuard.check(proxyOf(id)).then((alive) => {
      if (!auto.on) return;
      if (!alive) {
        s.nextAt = Date.now() + AUTO_FAIL_WAIT * 1000;
        s.note = 'прокси лежит — жду';
      } else autoFail(id, s);
      // упала проверка ответов посреди отдыха — сон между порциями не режем
      if (restUntil) s.nextAt = Math.max(s.nextAt, restUntil);
    });
    return;
  }
  s.fails = 0;
  s.batches++;
  // «смотрит ответы» могла пройти посреди долгого отдыха (флуд, «на сегодня всё»,
  // «проверки на сегодня»): причину отдыха она не меняет — не затираем её, иначе
  // статус теряет причину и показывает общее «пауза между заходами» вместо
  // «придержан Telegram»/«проверки на сегодня»
  if (!restUntil) s.note = '';
  // заход по НОМЕРАМ прошёл без упора в квоту — значит, квота вернулась.
  // Письма по чатам идут по @нику и контакты не добавляют: о квоте они
  // ничего не говорят, и снимать по ним ожидание нельзя
  const acc = accounts.list().find((a) => a.id === id);
  if (acc?.quotaUntil && (st?.done || 0) > 0 && s.jobSet === 'phones') {
    accounts.setField(id, { quotaUntil: '' });
    events.note('✅', 'квота на добавление контактов вернулась — продолжаю проверку и письма', acc.title);
  }
  /**
   * Проверка по одному номеру и письмо найденному — это не две пачки, а шаги
   * ОДНОЙ цепочки: проверил номер → написал → взял следующий. Между шагами
   * пауза такая же, как была между номерами внутри пачки, иначе на каждое
   * письмо уходило бы по сорок минут и дневной предел не выбрать за сутки.
   *
   * Долгий отдых — когда аккаунт выдал свою порцию писем (столько, сколько
   * раньше уходило за одну пачку) или когда делать стало нечего.
   */
  // Цепочку, оборвавшуюся надолго (новые сутки, упор в дневной предел,
  // остановка прогона), начинаем с нуля: иначе вчерашние письма укоротили бы
  // сегодняшнюю порцию.
  const stepMax = Math.max(o.check.delay, o.write.delayMax || o.write.delay) * 2 + 60;
  if (now - (s.chainAt || 0) > stepMax * 1000) s.chain = 0;
  s.chainAt = now;
  if (s.jobName === 'drafts') s.chain = (s.chain || 0) + (st?.done || 0);
  const portion = Math.max(1, o.write.limit);
  const chaining = (s.jobStep || s.jobName === 'drafts')
    && (st?.done || 0) > 0 && (s.chain || 0) < portion;

  // Глубокий сон: отработав свою порцию, аккаунт уходит из пула не на ровное
  // число секунд, а на вилку от заданной паузы до полутора от неё (40 минут
  // превращаются в 40-60). Ровный интервал виден по секундомеру не хуже,
  // чем полное его отсутствие.
  // Заход, не взявший ни одного номера (всё разобрали другие), столько ждать
  // не должен — там просто нечего было делать.
  let wait;
  if (chaining) {
    wait = s.jobName === 'drafts'
      ? Math.max(20, rnd(o.write.delay, Math.max(o.write.delay, o.write.delayMax)))
      : Math.max(10, Math.round(o.check.delay * (1 + Math.random() * 0.5)));
  } else {
    s.chain = 0;
    wait = st && st.done === 0
      ? Math.max(30, Math.min(o.pause, 60))
      : Math.round(o.pause * (1 + Math.random() * 0.5));
  }
  s.nextAt = now + wait * 1000;
  // это была проверка ответов посреди отдыха — возвращаем аккаунт в тот же отдых
  if (restUntil) {
    s.nextAt = Math.max(s.nextAt, restUntil);
    if (!(st && st.done)) return;
  }
  if (st && st.done && !chaining) push(`   «${title(id)}» уходит отдыхать на ${Math.round(wait / 60)} мин`);
}

/**
 * Автопрогон переживает перезапуск панели. Раньше любое падение или выкладка
 * молча его выключали: systemd поднимал панель, а рассылка стояла, пока
 * кто-нибудь не заметит. Теперь параметры запуска лежат в auto-run.json, пока
 * прогон идёт; ручная остановка и «работа кончилась» файл убирают, а падение —
 * нет, и после старта панель продолжает с того же места (очередь и лимиты
 * берутся из файлов, так что ничего не повторится).
 */
const AUTO_RUN = path.join(DIR, 'auto-run.json');
// последние настройки запуска — форма показывает их после обновления страницы,
// а не значения по умолчанию (галочки «второй шаг», «по очереди» слетали)
const AUTO_LAST = path.join(DIR, 'auto-last.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * Настройки последнего запуска — у каждого режима свои.
 * Файлы прежнего образца (одни настройки на всю панель) понимаем тоже:
 * их значения достаются обоим режимам.
 */
const autoLastForm = (set) => {
  const saved = readJson(AUTO_LAST) || readJson(AUTO_RUN)?.o || null;
  if (!saved) return null;
  const bySet = SETS.some((s) => saved[s]) ? saved : Object.fromEntries(SETS.map((s) => [s, saved]));
  return set ? (bySet[set] || null) : bySet;
};

/** Запомнить, что сейчас работает: это и переживает перезапуск, и помнит форма. */
function autoRemember() {
  const runs = {};
  for (const s of SETS) if (auto.live[s] && auto.opts[s]) runs[s] = auto.opts[s].raw;
  try {
    if (Object.keys(runs).length) {
      fs.writeFileSync(AUTO_RUN, JSON.stringify({ runs, at: new Date().toISOString() }, null, 2) + '\n');
    } else fs.rmSync(AUTO_RUN, { force: true });
  } catch {}
  const keep = autoLastForm() || {};
  for (const s of SETS) if (auto.opts[s]?.raw) keep[s] = auto.opts[s].raw;
  try { fs.writeFileSync(AUTO_LAST, JSON.stringify(keep, null, 2) + '\n'); } catch {}
}
function autoForget() { try { fs.rmSync(AUTO_RUN, { force: true }); } catch {} }

function autoResume() {
  const saved = readJson(AUTO_RUN);
  if (!saved) return;
  // новый образец — по режиму на запись; старый — один запуск с общим набором
  const runs = saved.runs
    || (saved.o ? { [SETS.includes(saved.set) ? saved.set : baseSet]: saved.o } : null);
  if (!runs) return;
  push('\n↺ панель перезапустилась — продолжаю автопрогон с прежними настройками');
  for (const [set, o] of Object.entries(runs)) {
    if (!SETS.includes(set)) continue;
    const r = autoStart({ ...o, set });
    if (!r.ok) push(`   ${setWord(set)}: продолжить не вышло — ${r.reason}`);
  }
  if (!auto.on) autoForget();
}

const autoPer = (q = false) => ({ nextAt: 0, lastAt: 0, note: q ? 'ограничение Telegram' : '',
                                  batches: 0, fails: 0, stopped: q, quarantine: q });

/**
 * Сон между порциями переживает перезапуск панели и новый запуск прогона.
 *
 * Раньше каждая выкладка (и «Остановить → Запустить») ставила всем nextAt=0:
 * аккаунт, написавший пять минут назад, шёл писать снова сразу, а не через
 * 40–60 минут. Состояние прогона живёт в памяти, зато журнал писем — на диске:
 * берём оттуда, когда аккаунт писал последний раз (по любому набору — IP-то
 * один), и досыпаем ему паузу порции o.pause.
 */
function restoreRest(ids, o) {
  const last = new Map();
  for (const set of SETS) {
    for (const r of readCsv('drafts.csv', set)) {
      if (!r.at || !(r.sent === 'true' || r.ok === 'true')) continue;
      if (!last.has(r.account) || r.at > last.get(r.account)) last.set(r.account, r.at);
    }
  }
  const now = Date.now();
  const byId = new Map(accounts.list().map((a) => [a.id, a]));
  for (const id of ids) {
    const s = auto.per.get(id);
    if (!s || s.stopped) continue;
    // отдых после флуда — из реестра (autoAfter пишет floodUntil): без этого
    // новый старт прогона обнулял его, и аккаунт шёл писать сразу
    const fl = Date.parse(byId.get(id)?.floodUntil || '');
    if (Number.isFinite(fl) && fl > now) {
      s.nextAt = Math.max(s.nextAt || 0, fl);
      s.floodUntil = fl;
      s.note = 'придержан Telegram за рассылку';
    }
    const t = Date.parse(last.get(id) || '');
    if (!Number.isFinite(t)) continue;
    const until = t + (o?.pause || 40 * 60) * 1000;
    if (until > now && until > (s.nextAt || 0)) {
      s.nextAt = until;
      s.note = 'досыпает после прошлой порции';
    }
  }
}

function autoStart(o) {
  // какой режим запускают: вкладка присылает свой набор, старые запуски
  // (и возобновление после перезапуска) — текущий общий
  const set = SETS.includes(o.set) ? o.set : baseSet;
  if (auto.live[set]) return { ok: false, reason: `рассылка ${setWord(set)} уже идёт` };
  const entered = accounts.list().filter((a) => accounts.hasSession(a) && accounts.isAuthed(a)
    && !a.reserve && !a.retired && !accounts.isReader(a));
  // аккаунты «только прогрев» в рассылку не идут, даже если их отметили
  const ready = entered.filter(accounts.inOutreach);
  const held = ready.filter(inQuarantine);
  const want = Array.isArray(o.accounts) ? o.accounts : [];
  const repliers = entered.filter((a) => !accounts.inOutreach(a) && wroteAny().has(a.id));
  // Аккаунт работает в одном режиме за раз: его набор — это его файлы,
  // его брони и его дневной счёт. Занятых другим режимом не берём молча.
  const other = SETS.find((s) => s !== set);
  const taken = new Set(auto.live[other] ? idsOfSet(other) : []);
  const ids = (want.length ? ready.filter((a) => want.includes(a.id)) : ready)
    .map((a) => a.id).filter((id) => !taken.has(id));
  if (ids.length) {
    // отвеченные письма аккаунтов на прогреве тоже разбираем — в прогоне они только за этим
    for (const a of repliers) if (!want.length || want.includes(a.id)) ids.push(a.id);
  }
  if (!ids.length) {
    return { ok: false, reason: !entered.length
      ? 'нет ни одного вошедшего аккаунта — подключи хотя бы один (шаг 1)'
      : !ready.length ? 'все вошедшие аккаунты стоят «только прогрев» — переведи хотя бы один в рассылку'
      : taken.size ? `выбранные аккаунты уже работают ${setWord(other)} — возьми свободные`
      : 'ни один из выбранных аккаунтов не вошёл или все они «только прогрев»' };
  }
  const mode = ['full', 'check', 'write'].includes(o.mode) ? o.mode : 'full';
  // «Только проверить» бывает только у набора номеров: по чатам люди уже в
  // Telegram, контакты там не добавляются, и проверок у набора чатов нет вовсе.
  // Режим приезжал из общей формы вкладки номеров, а признака «проверять нечего»
  // нигде не было: прогон стартовал, считал остаток по несуществующему
  // chats/numbers.csv, получал ноль работы и в ту же секунду заканчивался
  // «база пройдена» — не отправив ни одного письма. Лучше сказать словами.
  if (mode === 'check' && set === 'chats') {
    return { ok: false, reason: '«Только проверить» — это про номера: по чатам проверять нечего. ' +
      'Поставь на вкладке «Рассылка по номерам» режим «проверить и написать» или «только написать» — ' +
      'и запускай чаты.' };
  }
  // аккаунт с ограничением в рассылку не берём вовсе: он всё равно упрётся
  // в карантин на первой же пачке, только потратит заход
  if (mode !== 'check' && held.length) {
    for (const a of held) push(`⏸ «${a.title}» ограничен Telegram (${a.spam || 'смотри SpamBot'}) — вернётся в рассылку сам, когда срок пройдёт`);
    if (held.length === ids.length) {
      return { ok: false, reason: 'все выбранные аккаунты на карантине — Telegram ограничил им отправку' };
    }
  }
  const voice = !!o.voice && mode !== 'check';
  if (voice && !fs.existsSync(VOICE)) return { ok: false, reason: 'сначала загрузи голосовое (шаг 4)' };
  if (mode !== 'check' && !voice) {
    const read = (f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8').trim(); } catch { return ''; } };
    // «По чатам» берёт СВОЙ текст из своей вкладки (message-chat.txt) и не зависит
    // от текста «по номерам»; если своего нет — падает на общий. «По номерам» —
    // общий текст (message.txt). Раньше проверка всегда смотрела общий и блокировала
    // запуск чатов, хотя у них был свой текст.
    const txt = set === 'chats' ? (read('message-chat.txt') || read('message.txt')) : read('message.txt');
    if (!txt) return { ok: false, reason: set === 'chats'
      ? 'сначала сохрани текст для чатов на этой вкладке (шаг «Что напишем») — пустой прогонит базу вхолостую'
      : 'сначала сохрани текст сообщения (шаг «Что напишем») — пустой текст прогонит базу вхолостую' };
  }
  // воронка без второго письма — это заходы вхолостую: задача каждый раз
  // упиралась бы в «нет текста» и возвращалась ни с чем
  if (o.funnel) {
    const f = path.join(DIR, 'message2.txt');
    const has = fs.existsSync(f) && !!fs.readFileSync(f, 'utf8').trim();
    if (!has) return { ok: false, reason: 'второй шаг включён, а текста второго письма нет — напиши и сохрани его (шаг «Что напишем»)' };
    if (mode === 'check') return { ok: false, reason: 'второй шаг не сочетается с режимом «только проверить базу»' };
  }

  // ротация IP имеет смысл только по очереди: включаем режим вместе с ней
  const rotate = String(o.rotate ?? warmup.rotate ?? '').trim();
  if (rotate) {
    const bad = rotateUrlProblem(rotate);
    if (bad) return { ok: false, reason: bad };
  }

  // Общий адрес — работаем строго в один поток, даже если галочку не ставили.
  // Два аккаунта, пишущие с одного IP одновременно, — это то, за что Telegram
  // раздаёт ограничения быстрее всего, и полагаться тут на внимательность
  // человека нельзя.
  const shared = !ownProxyEach();
  // Общий адрес по умолчанию держит очередь (три акка с одного IP = риск бана).
  // Но пользователь может ЯВНО включить параллель на одном IP (o.parallel) —
  // тогда идём параллельно, под его ответственность, и честно предупреждаем.
  if (shared && o.parallel && !o.serial && !rotate) {
    push('⚠ параллельно на ОДНОМ IP — так просил; риск ограничений от Telegram выше. Для безопасной параллели нужны разные прокси.');
  }
  // Настройки — свои у каждого режима: «по номерам» может идти с проверкой и
  // паузой в час, «по чатам» — только письмами и по сорок минут.
  auto.opts[set] = {
    mode, voice,
    funnel: !!o.funnel,
    // «Написать лидам» (вкладка «Лиды»): по чатам пишем только лидам обогащения
    leadsOnly: set === 'chats' && !!o.leadsOnly,
    // «беречь новые аккаунты» — настройка РЕЖИМА, а не панели: иначе снятая
    // галочка на одной вкладке снимала отлёжку и у второго, уже идущего режима
    // (было `auto.warm && o.warm !== false` — общий тумблер на оба прогона)
    warm: o.warm !== false,
    send: !!o.send && !voice && mode !== 'check',
    check: { limit: num(o.checkLimit, 20, 1, 500), delay: num(o.checkDelay, 15, 5, 3600) },
    // пауза между людьми и пауза между «завёл контакт» и «написал» — обе
    // вилками: ровная задержка узнаётся по секундомеру не хуже, чем её отсутствие
    write: { limit: num(o.writeLimit, 2, 1, 200),
             delay: num(o.writeDelay, 180, 3, 3600),
             delayMax: num(o.writeDelayMax, 350, 3, 7200),
             hold: num(o.hold, 60, 5, 3600),
             holdMax: num(o.holdMax, 120, 5, 7200) },
    // после пачки аккаунт уходит из работы «вглубь»: 40-60 минут по умолчанию
    pause: num(o.pause, 40 * 60, 10, 24 * 3600),
    since: Date.now(),
    raw: o,                      // как режим запускали: это уходит в файл и в форму
  };
  auto.live[set] = true;
  for (const id of ids) auto.sets.set(id, set);

  // Прокси один на оба режима, поэтому очередь, работа по одному за раз и
  // смена IP — общие. Если второй режим просит строже, берём строже.
  //
  // wasOn снимаем ДО Object.assign: внутри литерала auto.on ещё старое значение
  // (свойства вычисляются до присваивания), а после него — уже true, поэтому
  // проверка «прогон только начался» должна смотреть на снимок.
  const wasOn = auto.on;
  Object.assign(auto, {
    on: true,
    serial: (auto.on && auto.serial) || !!o.serial || !!rotate || (shared && !o.parallel),
    rotate: rotate || (auto.on ? auto.rotate : ''),
    rotateWait: num(o.rotateWait, warmup.rotateWait || 10, 3, 600),
    // fresh/holdUntil/rotateFails — состояние МОДЕМА, а не режима. Пока прогон
    // идёт, второй запуск не должен их трогать: сброс holdUntil обрывал паузу
    // после смены IP (задача уходила в момент переподключения и падала), а
    // сброс rotateFails обнулял счётчик «три неудачи — останавливаемся», и
    // порог мог не сработать. Свежий старт — по-прежнему с чистого листа.
    ...(wasOn ? {} : { fresh: false, holdUntil: 0, rotateFails: 0 }),
    // верхнеуровневый warm — для старых экранов и ручных задач; сам режим
    // работает по своему значению в auto.opts[set].warm
    warm: o.warm !== false,
    // ограниченных Telegram держим в прогоне, но стоящими: когда срок
    // ограничения пройдёт, autoTick вернёт их в работу сам
    ids: [...new Set([...(auto.on ? auto.ids : []), ...ids])],
    since: auto.on ? auto.since : Date.now(),
  });
  // Свежий старт — состояние аккаунтов с нуля. Проверка была мёртвой: строкой
  // выше auto.on уже присвоено true, и карта не сбрасывалась никогда.
  if (!wasOn) auto.per = new Map();
  for (const id of ids) auto.per.set(id, autoPer(mode !== 'check' && held.some((a) => a.id === id)));
  restoreRest(ids, auto.opts[set]);   // недавно писавшие досыпают свою паузу
  // поля верхнего уровня держим в согласии с последним запуском: на них
  // смотрят старые экраны и ручные задачи
  Object.assign(auto, { mode, voice, funnel: auto.opts[set].funnel, send: auto.opts[set].send,
                        check: auto.opts[set].check, write: auto.opts[set].write,
                        pause: auto.opts[set].pause });

  const what = mode === 'check' ? 'только проверка базы'
             : mode === 'write' ? 'только рассылка' : 'проверка и рассылка';
  if (auto.serial) {
    push(auto.rotate
      ? `\n↻ по очереди, по одному аккаунту за раз; между ними — смена IP на прокси`
      : `\n↻ по очереди, по одному аккаунту за раз`);
    if (shared && !o.serial) {
      push('   (иначе нельзя: у аккаунтов общий адрес — либо один прокси на всех, либо прокси нет вовсе)');
    }
  }
  const how = auto.voice ? 'ГОЛОСОВЫМ, уходит людям'
            : auto.send ? 'С ОТПРАВКОЙ — сообщения уходят людям' : 'только черновики';
  // в заголовке — те, кто РЕАЛЬНО работает: снятые карантином сюда не попадают,
  // иначе строка обещает больше, чем прогон делает
  push(`\n▶▶ АВТОПРОГОН ${setWord(set).toUpperCase()}: ${ids.map(title).join(', ')}`);
  if (auto.live[other]) {
    push(`   параллельно идёт рассылка ${setWord(other)} (${idsOfSet(other).map(title).join(', ')}) — ` +
         'аккаунты разные, прокси общий, работают по очереди');
  }
  push(`   ${what} · ${how} · отдых между пачками ${Math.round(auto.pause / 60)}-` +
       `${Math.round(auto.pause * 1.5 / 60)} мин` +
       ` · максимум ${getMaxCap() || 15} в сутки на аккаунт` +
       (auto.warm ? ' · прогрев новых аккаунтов включён' : ' · ПРОГРЕВ ВЫКЛЮЧЕН'));
  if (auto.warm) {
    for (const id of ids) {
      const acc = accounts.list().find((a) => a.id === id);
      const w = warm(acc);
      push(`   «${acc.title}»: день ${w.day} — ${w.note}` +
           (w.resting ? ` (ещё ${fmtLeft(w.restLeft)})` : ` · сегодня осталось ${w.left}`));
    }
  }
  // ссылку ротации помним на будущее: её же берёт прогрев поведением
  if (rotate && rotate !== warmup.rotate) {
    warmup.rotate = rotate;
    warmup.rotateWait = auto.rotateWait;
    warmSave();
  }
  if (!auto.timer) auto.timer = setInterval(autoTick, AUTO_TICK);
  autoRemember();                 // параметры режимов — в auto-run.json / auto-last.json
  autoTick();
  return { ok: true };
}

/**
 * Один режим закончил работу. Второй при этом продолжает: у них разные
 * аккаунты, разные файлы и свой конец у каждого.
 */
function finishSet(set, why) {
  if (!auto.live[set]) return;
  const ids = idsOfSet(set);          // считаем ДО того, как разберём таблицу наборов
  auto.live[set] = false;
  auto.opts[set] = null;
  for (const id of ids) { auto.sets.delete(id); auto.per.delete(id); }
  auto.ids = auto.ids.filter((id) => !ids.includes(id));
  if (!SETS.some((s) => auto.live[s])) return autoStop(`рассылка ${setWord(set)} — ${why}`);
  push(`■ рассылка ${setWord(set)} остановлена: ${why}`);
  autoRemember();
}

/**
 * Состав работающего режима меняют галочками прямо на вкладке, не останавливая
 * рассылку: отметил — аккаунт входит в работу, снял — выходит.
 *
 * Выходящему задачу не дорабатываем: иначе галочка снята, а он ещё пишет.
 */
function setCrew(set, want) {
  if (!auto.live[set]) return { ok: false, reason: 'этот режим сейчас не работает' };
  const byId = new Map(accounts.list().map((a) => [a.id, a]));
  const other = SETS.find((s) => s !== set);
  const taken = new Set(auto.live[other] ? idsOfSet(other) : []);
  const now = idsOfSet(set);
  const keep = want.filter((id) => {
    const a = byId.get(id);
    return a && accounts.hasSession(a) && accounts.isAuthed(a)
      && accounts.inOutreach(a) && !taken.has(id);
  });
  if (!keep.length) { stopSet(set, 'сняли все аккаунты'); return { ok: true, stopped: true }; }

  const add = keep.filter((id) => !now.includes(id));
  const drop = now.filter((id) => !keep.includes(id));
  for (const id of drop) {
    auto.sets.delete(id);
    auto.per.delete(id);
    auto.ids = auto.ids.filter((x) => x !== id);
    const r = running.get(id);
    if (r) { r.child.kill('SIGTERM'); push(`⏹ «${title(id)}» снят с рассылки ${setWord(set)} — задача остановлена`); }
    else push(`⏹ «${title(id)}» снят с рассылки ${setWord(set)}`);
  }
  for (const id of add) {
    auto.ids.push(id);
    auto.sets.set(id, set);
    auto.per.set(id, autoPer((auto.opts[set]?.mode || 'full') !== 'check' && inQuarantine(byId.get(id))));
    restoreRest([id], auto.opts[set]);
    push(`▶ «${title(id)}» добавлен в рассылку ${setWord(set)}`);
  }
  if (add.length || drop.length) {
    // чтобы перезапуск панели поднял тот же состав, а не прежний
    if (auto.opts[set]?.raw) auto.opts[set].raw.accounts = idsOfSet(set);
    autoRemember();
    autoTick();
  }
  return { ok: true, ids: idsOfSet(set) };
}

/** Остановка одного режима руками: его задачи дорабатывать незачем. */
function stopSet(set, why) {
  const ids = idsOfSet(set);
  finishSet(set, why);
  for (const id of ids) {
    const r = running.get(id);
    if (r) { r.child.kill('SIGTERM'); push(`⏹ остановлено вручную: ${r.title}`); }
  }
}

function autoStop(why) {
  if (!auto.on) return;
  autoForget();
  auto.on = false;
  auto.live = { phones: false, chats: false };
  auto.opts = { phones: null, chats: null };
  auto.sets = new Map();
  clearInterval(auto.timer);
  auto.timer = null;
  push(`■■ автопрогон остановлен: ${why}`);
}

/** Что показывать в панели, пока прогон идёт. */
/** Статус аккаунта в прогоне — одна функция и для прогона, и для экрана аккаунтов. */
function autoStatusFor(id) {
  if (!auto.on || !auto.ids.includes(id)) return '';
  const s = auto.per.get(id) || {};
  const acc = accounts.list().find((x) => x.id === id);
  const wait = Math.max(0, Math.round(((s.nextAt || 0) - Date.now()) / 1000));
  return autoStatus(s, running.get(id)?.title || '',
    { today: doneToday(id), cap: acc ? warm(acc).cap : 0, checks: checksOf(id), wait }, acc);
}

/** Во что превращаются названия задач в строке аккаунта. */
const TASK_WORD = [
  [/^Проверка базы/, 'проверяет номера'], [/^Черновики/, 'пишет людям'],
  [/^Смотрит ответы/, 'смотрит, кто ответил'], [/^Прогрев/, 'догревается: переписка, чтение, реакции'],
  [/^(Профиль|Аватарка)/, 'меняют профиль (ты)'], [/^Сводка/, 'сводка'],
];
const ekbTime = (t) => new Intl.DateTimeFormat('ru-RU',
  { timeZone: WORK_TZ, hour: '2-digit', minute: '2-digit' }).format(t);
// с датой — для сроков дольше суток (отдых после заморозки)
const ekbDateTime = (t) => new Intl.DateTimeFormat('ru-RU',
  { timeZone: WORK_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(t);

/** Рассылке этот аккаунт сегодня больше не нужен (или не нужен до утра). */
function outreachDoneForNow(acc) {
  const o = optOf(acc.id);
  const cap = warm(acc).cap;
  const writeDone = cap > 0 && doneToday(acc.id) >= cap;
  const checkDone = o.mode === 'write' || setOf(acc.id) === 'chats' || checksOf(acc.id).left <= 0;
  const cantWrite = o.mode === 'check' || writeDone || !isWorkTime();
  return cantWrite && checkDone;
}

/** Почему аккаунт отдыхает — словами, а не внутренней пометкой. */
const REST_WHY = {
  'квота на сегодня': 'Telegram: кончилась квота на добавление контактов',
  'придержан Telegram': 'Telegram попросил паузу (флуд)',
  'придержан Telegram за рассылку': 'Telegram ограничил рассылку незнакомым (PEER_FLOOD) — отлёживается',
  'сбои подряд': 'несколько сбоев подряд, передышка',
  'сбой, пробую снова': 'сбой, повторю позже',
  'дневной предел': 'письма на сегодня выбраны',
  'проверки на сегодня': 'проверки на сегодня выбраны',
  'отлёжка': 'отлёжка нового аккаунта',
  'очередь писем полна': 'уже нашёл людей на 2 дня писем — новых не проверяет, пока не напишет',
};

function autoStatus(s, busy, { today, cap, checks, wait }, acc) {
  if (s.stopped && s.quarantine && acc) return `⛔ ограничен Telegram: ${acc.spam || 'смотри SpamBot'}`;
  if (!busy && baseSet === 'phones' && acc?.quotaUntil && Date.now() < Date.parse(acc.quotaUntil)) {
    const left = Math.round((Date.parse(acc.quotaUntil) - Date.now()) / 1000);
    return `ждёт до ${ekbTime(Date.parse(acc.quotaUntil))}, ещё ${fmtLeft(left)} — Telegram: кончилась квота на добавление контактов (письма и проверка стоят, ответы смотрит)`;
  }
  if (s.stopped) return `выбыл из прогона: ${s.note || 'смотри журнал'}`;
  if (busy) return (TASK_WORD.find(([re]) => re.test(busy)) || [null, busy])[1];
  if (acc && !accounts.inOutreach(acc)) {
    return s.funnelAt ? `на прогреве — ответы смотрит раз в час, следующий раз в ${ekbTime(s.funnelAt)} по Екб`
                      : 'на прогреве — в прогоне только смотрит ответы';
  }
  const o = acc ? optOf(acc.id) : auto;
  const writeDone = cap > 0 && today >= cap;
  // Выбрал дневной предел писем — день кончился целиком: проверять номера
  // про запас аккаунт не идёт, проверка стоит того же, что письмо.
  // «Только проверять» — особый случай: там предел считается по проверкам.
  const checkDone = (acc && setOf(acc.id) === 'chats') || checks.left <= 0
    || (writeDone && o.mode !== 'check');
  if (writeDone && (checkDone || o.mode === 'write')) {
    return 'на сегодня всё — продолжит завтра'
      + (warmup.on ? ' (в перерыве догревается)' : '')
      + (o.funnel ? ', ответы смотрит раз в час' : '');
  }
  if (manualBusy()) return 'пауза — ты работаешь с аккаунтами';
  if (!isWorkTime() && o.mode !== 'check' && (checkDone || o.mode === 'write')) {
    return `ночь — пишет с ${WORK_FROM}:00`;
  }
  if (wait > 0) {
    const why = REST_WHY[s.note] || (s.note ? s.note : 'пауза между заходами');
    return `отдыхает до ${ekbTime(Date.now() + wait * 1000)}, ещё ${fmtLeft(wait)} — ${why}`;
  }
  return auto.serial ? 'ждёт своей очереди' : 'сейчас возьмёт работу';
}

function autoView() {
  const now = Date.now();
  // по режиму на вкладку: что идёт, с какими настройками и чьими аккаунтами
  const runs = Object.fromEntries(SETS.map((set) => {
    const o = auto.opts[set];
    return [set, {
      on: !!auto.live[set],
      mode: o?.mode || 'full', send: !!o?.send, voice: !!o?.voice,
      leadsOnly: !!o?.leadsOnly,
      pause: o?.pause || 0, since: o?.since || 0,
      ids: idsOfSet(set),
      form: autoLastForm(set),
    }];
  }));
  return {
    on: auto.on, mode: auto.mode, send: auto.send, voice: auto.voice,
    pause: auto.pause, since: auto.since,
    set: baseSet,
    runs,
    form: autoLastForm(baseSet),
    serial: auto.serial, rotate: !!auto.rotate,
    hold: Math.max(0, Math.round((auto.holdUntil - now) / 1000)),
    accounts: auto.ids.map((id) => {
      const s = auto.per.get(id) || {};
      const acc = accounts.list().find((x) => x.id === id);
      const cap = acc ? warm(acc).cap : 0;
      const today = doneToday(id);
      const checks = checksOf(id);
      const wait = Math.max(0, Math.round(((s.nextAt || 0) - now) / 1000));
      return {
        id, title: acc ? (acc.name || acc.title) : id, phone: acc?.title || '',
        set: setOf(id),
        stopped: !!s.stopped,
        today, cap, checks,
        // что аккаунт делает — человеческим языком; решает сервер, а не
        // экран по сырым полям (иначе «свободен» у того, кто ждёт завтра)
        status: autoStatus(s, running.get(id)?.title || '', { today, cap, checks, wait }, acc),
        working: running.has(id),
      };
    }),
  };
}

/**
 * Запустить одну задачу сразу на нескольких аккаунтах — параллельно.
 * Базу они делят бронями (claims), поэтому по одному номеру не пройдут дважды.
 * Занятый чем-то другим или невошедший аккаунт просто пропускаем и говорим,
 * кого именно.
 */
/**
 * Разбор чатов всеми свободными аккаунтами сразу. Чаты делятся между ними:
 * каждый идёт по списку со своего места и берёт следующий чат, который ещё
 * никто не взял (parse-chat.py --share, бронь в claims.json). Предел «человек
 * за заход» делится поровну.
 *
 * На один прокси — не больше одного аккаунта: два аккаунта с одного адреса
 * сразу — ровно то, от чего бережёт вся панель. Прокси общий — пойдёт один,
 * как раньше; у каждого свой — все свободные разом.
 */
function parseCrew() {
  const busyProxy = new Set([...running.keys()].map((id) => proxyOf(id) || 'direct'));
  const byProxy = new Map();
  for (const a of accounts.list()) {
    if (!accounts.hasSession(a) || !accounts.isAuthed(a)) continue;
    if (running.has(a.id) || accessBusy.has(a.id)) continue;
    if (accounts.fullRestLeft(a)) continue;                       // полный отдых: к Telegram ни ногой
    if (a.spamOk === false && a.spamKind === 'frozen') continue;  // замороженный ничего не прочтёт
    if (warm(a).resting) continue;                                // первые сутки аккаунт не трогаем
    const key = a.proxy || 'direct';
    if (busyProxy.has(key) || proxyGuard.down(a.proxy) || byProxy.has(key)) continue;
    byProxy.set(key, a);
  }
  return [...byProxy.values()];
}

function startParseAll(opts) {
  const crew = parseCrew();
  if (!crew.length) {
    return { ok: false, reason: 'свободных аккаунтов нет: все заняты, на отдыхе или их прокси сейчас работает' };
  }
  const n = crew.length;
  const limit = Number(opts.limit) > 0 ? Math.ceil(Number(opts.limit) / n) : 0;
  let started = 0;
  const skipped = [];
  crew.forEach((a, i) => {
    const r = start('parse', { ...opts, account: a.id, limit, shard: i, shards: n });
    if (r.ok) started++; else skipped.push(`${a.title}: ${r.reason}`);
  });
  if (!started) return { ok: false, reason: skipped[0] || 'разбор не запустился' };
  if (n > 1) {
    events.note('🔎', `разбор чатов параллельно — аккаунтов: ${started}, каждый со своего прокси` +
      (limit ? ` · по ${limit} человек на аккаунт` : ''));
  }
  return { ok: true, started, skipped, names: crew.map((a) => a.name || a.title) };
}

function startMany(name, ids, opts) {
  let started = 0;
  const skipped = [];
  // несколько аккаунтов разом с одного IP — письма разводим, как в автопрогоне
  if (name === 'drafts' && ids.length > 1 && !ownProxyEach()) opts = { ...opts, sendGap: true };
  for (const id of ids) {
    const r = start(name, { account: id, ...opts });
    if (r.ok) started++;
    else skipped.push(r.reason || id);
  }
  if (!started) {
    return { ok: false, reason: skipped[0] || 'ни один аккаунт не запустился' };
  }
  return { ok: true, started, skipped };
}

/* ═══════════ ФАЙЛЫ И ВНЕШНИЕ ПРОГРАММЫ — python, ffmpeg, база, голосовое ═══════════ */

/** Python для разбора базы: venv-tg (openpyxl+opentele), потом venv, потом системный. */
function pythonCmd() {
  const win = process.platform === 'win32';
  const cands = [
    path.join(CODE, 'venv-tg', win ? 'Scripts\\python.exe' : 'bin/python'),
    path.join(CODE, 'venv', win ? 'Scripts\\python.exe' : 'bin/python'),
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  return win ? 'python' : 'python3';
}
/** Есть ли внутри zip готовая папка tdata (а не Telethon .session). */
function zipHasTdata(zip) {
  try {
    const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
    return /(^|\/)tdata\//m.test(names) || /(^|\/)key_datas$/m.test(names);
  } catch { return false; }
}
const BASEMETA = path.join(DIR, 'base.json');
const UPLOADS = path.join(DIR, 'uploads');
const BASE_EXT = /\.(xlsx|xlsm|csv|tsv|txt)$/i;
const ACCFILE_EXT = /\.(zip|session)$/i;
const VOICE = path.join(DIR, 'voice.ogg');
const VOICEMETA = path.join(DIR, 'voice.json');
const VOICE_EXT = /\.(ogg|oga|opus|mp3|m4a|aac|wav|mp4|webm)$/i;

/** ffmpeg/ffprobe: сначала рядом с панелью (можно положить бинарь), потом из PATH. */
function toolCmd(name) {
  const win = process.platform === 'win32';
  const local = path.join(CODE, win ? `${name}.exe` : name);
  return fs.existsSync(local) ? local : name;
}

/**
 * Готовит голосовое из любого аудио: ffmpeg переводит в ogg/opus, моно —
 * формат голосовых заметок Telegram. Без ffmpeg берём только уже готовый
 * .ogg/.opus как есть. Длительность читаем ffprobe'ом, панель покажет её,
 * и Telegram нарисует полоску, а не 0:00.
 */
function makeVoice(srcPath, origName) {
  try {
    execFileSync(toolCmd('ffmpeg'),
      ['-y', '-i', srcPath, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', VOICE],
      { stdio: 'ignore' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (/\.(ogg|oga|opus)$/i.test(origName)) fs.copyFileSync(srcPath, VOICE);
      else throw new Error('нет ffmpeg — запиши голосовое в Telegram и загрузи файл .ogg, либо поставь ffmpeg');
    } else {
      throw new Error('не получилось сделать голосовое: ' + (e.message || '').split('\n')[0]);
    }
  }
  let duration = 0;
  try {
    const out = execFileSync(toolCmd('ffprobe'),
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', VOICE],
      { encoding: 'utf8' });
    duration = Math.max(0, Math.round(parseFloat(out) || 0));
  } catch {}
  const meta = { name: origName, duration, at: new Date().toISOString() };
  fs.writeFileSync(VOICEMETA, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}
const voiceMeta = () => { try { return JSON.parse(fs.readFileSync(VOICEMETA, 'utf8')); } catch { return null; } };

/**
 * Подключение аккаунта готовой сессией. Что внутри загруженного файла —
 * решаем по нему самому: .zip с папкой tdata → import-tdata, иначе (архив
 * с .session или сам .session) → import-session. Оба принимают одинаковый
 * первый аргумент, различается только скрипт.
 */
function importAccount(accId, file) {
  const acc = accounts.list().find((a) => a.id === accId);
  if (!acc) return { ok: false, reason: 'аккаунт не найден' };
  if (running.get(accId)) return { ok: false, reason: 'аккаунт сейчас занят' };

  /**
   * Чем читать архив.
   *
   * Продавцы часто кладут в один .zip и .session, и папку tdata. Брать надо
   * .session: он читается парой строк и не тянет за собой opentele с PyQt5
   * (на сервере их обычно и нет). tdata остаётся запасным путём — для архивов,
   * где .session не положили вовсе.
   */
  let tdata = false;
  if (/\.zip$/i.test(file)) {
    try {
      const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' });
      const hasSession = /\.session$/m.test(names);
      const hasTdata = /(^|\/)tdata\//m.test(names) || /(^|\/)key_datas$/m.test(names);
      tdata = hasTdata && !hasSession;
    } catch {}
  }
  const flag = tdata ? '--tdata' : '--session';
  run(accId, acc.title, `Подключение сессии — ${acc.title}`,
      pythonCmd(), [path.join(CODE, 'import-account.py'), '--account', accId, flag, file]);
  return { ok: true, kind: tdata ? 'TDATA' : 'session' };
}

/**
 * Разбирает файл базы по указанному пути в numbers.csv.
 *
 * Путь приходит из браузера, поэтому он опасен: на сервере, доступном снаружи,
 * это чтение чужих файлов. Поэтому «загрузить по пути» работает ТОЛЬКО когда
 * панель слушает локальный адрес — там это просто удобство для своего же
 * компьютера. Наружу остаётся загрузка файлом, она безопасна.
 */
function loadBase(file) {
  if (running.has('_base')) return { ok: false, reason: 'база уже разбирается' };
  if (!LOCAL) {
    return { ok: false, reason: 'загрузка по пути доступна только на локальной панели — ' +
      'перетащи файл в окно, так безопаснее' };
  }
  const clean = path.resolve(String(file).replace(/^~(?=\/)/, process.env.HOME || '~').trim());
  if (!BASE_EXT.test(clean)) {
    return { ok: false, reason: 'нужен файл .xlsx, .xlsm, .csv или .tsv' };
  }
  let st;
  try { st = fs.statSync(clean); } catch { st = null; }
  if (!st || !st.isFile()) return { ok: false, reason: `файл не найден: ${clean}` };
  // файл с номерами — это всегда набор «по номерам»; туда же и переключаемся
  setBaseSet('phones');
  run('_base', 'база', 'Загрузка базы', pythonCmd(),
      [path.join(DIR, 'extract_numbers.py'), clean, path.join(DIR, 'numbers.csv')],
      (code) => {
        if (code !== 0) return;
        fs.writeFileSync(BASEMETA, JSON.stringify(
          { file: path.basename(clean), at: new Date().toISOString() }, null, 2) + '\n');
      }, 'phones');
  return { ok: true };
}

/**
 * Вход по номеру: скрипт login-code.py и панель общаются через файлы рядом
 * с картинками QR. Скрипт пишет «жду код», панель кладёт то, что ввёл человек.
 * Через сеть код передавать некуда: дочерний процесс не слушает порт, а через
 * командную строку он бы засветился в списке процессов.
 */
const QR = path.join(DIR, 'qr');
const okId = (id) => /^[a-z0-9_-]+$/i.test(String(id || ''));
const codeWait = (id) => {
  if (!okId(id)) return '';
  try { return fs.readFileSync(path.join(QR, `${id}.code-wait`), 'utf8').trim(); }
  catch { return ''; }
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const body = (req) => new Promise((r) => {
  let d = ''; req.on('data', (c) => (d += c));
  req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } });
});
/** Тело запроса как есть — файл прилетает потоком, без multipart. */
const rawBody = (req, limit = 50 * 1024 * 1024) => new Promise((ok, no) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { no(new Error('файл больше 50 МБ')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', no);
});

const WEB = path.join(CODE, 'web');
// Подстановки пишут руками — «{ name}», «{Name}», «{имя}», а рассылка ищет ровно
// {name}: письмо ушло бы с фигурными скобками (16.10 так ушло 123). Приводим при
// сохранении; варианты {а|б} не трогаем. То же — fix_placeholders в tglib.py
const PH_ALIAS = { name: 'name', 'имя': 'name', date: 'date', 'дата': 'date', username: 'username',
  'ник': 'username', chat: 'chat', 'чат': 'chat', link: 'LINK', 'ссылка': 'LINK' };
const fixPlaceholders = (t) => String(t).replace(/\{([^{}|]*)\}/g, (_, b) => {
  const k = b.trim();
  return '{' + (PH_ALIAS[k.toLowerCase()] || k) + '}';
});
const page = (res, file) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
                       'cache-control': 'no-store' });
  res.end(fs.readFileSync(path.join(WEB, file)));
};

/**
 * Отдача статики из web/. Список файлов закрытый: собирать путь из того, что
 * прислал браузер, нельзя — так уходят за пределы папки и читают чужое.
 */
const STATIC = {
  '/app.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
};
/* ═══════════ HTTP — статика, вход, маршруты API ═══════════ */

function serveStatic(res, pathname) {
  const type = STATIC[pathname];
  if (!type) return false;
  const file = path.join(WEB, path.basename(pathname));
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
  return true;
}

async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const ip = req.socket.remoteAddress || '?';

    /**
     * Чужая страница не может ни поставить свой заголовок, ни подделать Origin,
     * а кука уходит с любым запросом — поэтому оба условия проверяем на каждом
     * изменяющем запросе.
     */
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin) {
        let bad = true;
        try { bad = new URL(origin).host !== req.headers.host; } catch {}
        if (bad) return json(res, 403, { error: 'чужой источник запроса' });
      }
      if (req.headers['x-panel'] !== '1') return json(res, 403, { error: 'запрос не из панели' });
    }

    if (req.method === 'GET' && serveStatic(res, u.pathname)) return;

    const token = auth.cookieFrom(req.headers.cookie)[auth.COOKIE];
    // Панель может стоять за привратником: логин и пароль профиля он спросил
    // сам, а к своей панели ходит с ключом, выданным ей при запуске. Ключ
    // живёт только в памяти обоих, порт панели смотрит в 127.0.0.1.
    const authed = auth.valid(token) || innerOk(req.headers['x-panel-token']);

    if (u.pathname === '/api/login' && req.method === 'POST') {
      const wait = auth.blocked(ip);
      if (wait) return json(res, 429, { ok: false, reason: `слишком много попыток, подожди ${wait} с` });
      const { user, pass } = await body(req);
      if (!auth.check(user, pass)) {
        auth.noteFail(ip);
        return json(res, 401, { ok: false, reason: 'логин или пароль не подходят' });
      }
      auth.noteOk(ip);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${auth.COOKIE}=${auth.issue()}; HttpOnly; SameSite=Strict; Path=/; ` +
                      `Max-Age=${14 * 86400}${TLS ? '; Secure' : ''}`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (u.pathname === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${auth.COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // всё остальное — только для вошедших
    if (!authed) {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/login')) {
        return page(res, 'login.html');
      }
      return json(res, 401, { error: 'нужен вход' });
    }

    if (u.pathname === '/') return page(res, 'index.html');
    if (u.pathname === '/login') { res.writeHead(302, { location: '/' }); return res.end(); }

    /* ───────── АККАУНТЫ — список, заведение, профиль, прокси, Desktop ───────── */

    /** Аватарка аккаунта — её кладёт tglib.save_avatar при подключении. */
    if (u.pathname === '/api/avatar') {
      const id = u.searchParams.get('id') || '';
      const file = path.join(DIR, 'avatars', `${id}.jpg`);
      if (!okId(id) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }

    if (u.pathname === '/api/accounts') {
      const drafted = readAll('drafts.csv');
      const held = claims.active().filter((h) => h.task !== 'parse');   // брони чатов разбора — не номера
      // числа по каждому аккаунту — одним проходом по истории. Раньше тут
      // было три перебора всей истории НА КАЖДЫЙ аккаунт, а запрос этот
      // панель шлёт каждые две секунды
      const tally = new Map();
      // разгон после отдыха без рассылки начинается заново (server/warmup.mjs)
      const restFrom = new Map(accounts.list().map((a) => [a.id, restEnd(a)]));
      for (const r of drafted) {
        const t = tally.get(r.account) || { drafts: 0, sent: 0, firstAt: '' };
        if (r.ok === 'true') t.drafts++;
        if (r.sent === 'true') t.sent++;
        // первый реальный контакт аккаунта — от него считаем «день рассылки» (разгон)
        if ((r.ok === 'true' || r.sent === 'true') && r.at && (!t.firstAt || r.at < t.firstAt)
            && Date.parse(r.at) >= (restFrom.get(r.account) || 0)) t.firstAt = r.at;
        tally.set(r.account, t);
      }
      const today = doneTodayAll(drafted);
      const own = ownProxy.assigned();      // свой IP аккаунта (раздача сессий Asocks)
      return json(res, 200, accounts.list().map((a) => ({
        id: a.id, title: a.title,
        // время аватарки — для адреса картинки: сменили фото — браузер возьмёт новое
        avatar: (() => { try { return fs.statSync(path.join(DIR, 'avatars', `${a.id}.jpg`)).mtimeMs | 0; }
                         catch { return 0; } })(),
        authed: accounts.isAuthed(a),
        proxy: a.proxy || '',
        proxyLabel: accounts.proxyLabel(a.proxy),
        // шлюз у всех своих сессий один — в строке показываем сам IP, иначе не отличить от общего
        ownIp: a.proxyOwn ? (own[a.id]?.ip || '') : '',
        // реальный выходной IP и страна (сторож проверяет раз в 10 мин) — чтобы в
        // панели видеть, что у всех РАЗНЫЙ IP и все в KZ, даже если прокси вставлен руками
        exitIp: (() => { const i = proxyGuard.info(a.proxy); return i.down ? '' : (i.ip || ''); })(),
        exitCountry: (() => { const i = proxyGuard.info(a.proxy); return i.down ? '' : (i.country || ''); })(),
        // отпечаток устройства (чем аккаунт представляется Telegram)
        fp: (() => { const d = a.device || {}; return d.device_model
          ? `${d.device_model} · ${d.system_version || ''} · Telegram ${d.app_version || ''}`
          : 'Desktop · Windows 10 · Telegram 4.9.9 (умолч.)'; })(),
        drafts: tally.get(a.id)?.drafts || 0,
        sent: tally.get(a.id)?.sent || 0,
        busy: running.get(a.id)?.title || '',
        session: accounts.hasSession(a),
        profile: fs.existsSync(path.join(DIR, a.dir, 'Default')),
        // кто это на самом деле — панель показывает рядом с названием,
        // иначе после добавления видно только придуманное имя
        name: a.name || '', username: a.username || '', phone: a.phone || '',
        // профиль в Telegram: «о себе» и канал-прокладка (пишет profile.py)
        about: a.about || '', channel: a.channel || '', channelTitle: a.channelTitle || '',
        channelOn: !!a.channelOn,
        held: held.filter((h) => h.account === a.id).reduce((s, h) => s + h.n, 0),
        warm: accounts.hasSession(a) ? warm(a, today.get(a.id) || 0) : null,
        dailyCap: Number(a.dailyCap) || 0,   // ручной предел на аккаунт (0 — авто)
        role: accounts.isReader(a) ? 'read' : accounts.inOutreach(a) ? 'send' : 'warm',
        // в каком режиме аккаунт сейчас занят: по нему вкладки показывают,
        // кто свободен, а кого брать нельзя
        run: auto.on && auto.ids.includes(a.id) ? setOf(a.id) : '',
        sentToday: today.get(a.id) || 0,
        checks: checksOf(a.id),          // проверки номеров сегодня и дневной предел
        now: autoStatusFor(a.id),        // что делает в прогоне и почему отдыхает
        spamUntil: a.spamUntil || '', spamKind: a.spamKind || '',
        // после заморозки: «без рассылки» (греется, людям не пишет) или полный отдых
        // строкой из реестра, а не «сейчас + остаток»: иначе значение плывёт на
        // миллисекунды и список аккаунтов перерисовывается на каждом опросе
        holdUntil: accounts.sendHoldLeft(a) && !accounts.fullRestLeft(a) ? a.sendHoldUntil : '',
        restUntil: accounts.fullRestLeft(a) ? a.fullRestUntil : '',
        // день рассылки: 0 в первый день реальных сообщений, -1 если ещё не начинали.
        // по нему калькулятор считает разгон рассылки (2→5→8→12→15), а не возраст прогрева
        outreachDay: tally.get(a.id)?.firstAt
          ? Math.floor((Date.now() - Date.parse(tally.get(a.id).firstAt)) / 864e5) : -1,
        // вход по коду ждёт, что человек введёт код (или пароль 2FA):
        // спросить может только панель — у скрипта собеседника нет
        codeWait: codeWait(a.id),
        // что сказал @SpamBot и не снят ли аккаунт с рассылки
        spam: a.spam || '', spamAt: a.spamAt || '', quarantine: inQuarantine(a),
        // под каким устройством аккаунт заходит: у каждого своё, и это видно
        device: a.device?.device_model || '',
      })));
    }

    if (u.pathname === '/api/accounts/add' && req.method === 'POST') {
      const { title, proxy, method, phone } = await body(req);
      const acc = accounts.add(title);
      // прокси ставим ДО входа: сессия должна привязаться сразу к нужному адресу,
      // иначе Telegram увидит один IP при логине и другой при работе
      if (proxy) {
        try { accounts.setProxy(acc.id, proxy); }
        catch (e) { accounts.remove(acc.id); return json(res, 200, { ok: false, reason: e.message }); }
      }
      const warn = accounts.proxyWarning(proxy);
      // method === 'file' — вход готовой сессией, файл прилетит отдельным
      // запросом на /api/accounts/import; QR не открываем
      if (method === 'file') {
        push(`\n+ заведён «${acc.title}» (${accounts.proxyLabel(proxy)}) — жду файл сессии`);
        if (warn) push(`⚠ ${warn}`);
        return json(res, 200, { ok: true, id: acc.id, warn, method: 'file' });
      }
      // method === 'code' — вход по номеру: Telegram пришлёт код, панель
      // спросит его отдельным запросом, когда скрипт об этом попросит
      if (method === 'code') {
        await freshIpForLogin();
        const r = start('code', { account: acc.id, phone });
        if (!r.ok) { accounts.remove(acc.id); return json(res, 200, r); }
        push(`\n+ заведён «${acc.title}» (${accounts.proxyLabel(proxy)}) — жду код из Telegram`);
        if (warn) push(`⚠ ${warn}`);
        return json(res, 200, { ok: true, id: acc.id, warn, method: 'code' });
      }
      push(`\n+ заведён «${acc.title}» (${accounts.proxyLabel(proxy)}) — сейчас откроется окно с QR-кодом`);
      if (warn) push(`⚠ ${warn}`);
      await freshIpForLogin();
      start('login', { account: acc.id });
      return json(res, 200, { ok: true, id: acc.id, warn });
    }

    /** Код (или облачный пароль), который человек ввёл в панели. */
    if (u.pathname === '/api/accounts/code' && req.method === 'POST') {
      const { account, code, password } = await body(req);
      if (!okId(account)) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      if (!codeWait(account)) {
        return json(res, 200, { ok: false, reason: 'вход по коду сейчас не идёт — начни заново' });
      }
      const clean = String(code || '').replace(/\D/g, '').slice(0, 12);
      const pass = String(password || '').slice(0, 256);
      if (!clean && !pass) return json(res, 200, { ok: false, reason: 'пусто' });
      fs.mkdirSync(QR, { recursive: true });
      fs.writeFileSync(path.join(QR, `${account}.code`),
                       JSON.stringify({ code: clean, password: pass }));
      push(`  код принят, продолжаю вход «${account}»`);
      return json(res, 200, { ok: true });
    }

    if (u.pathname === '/api/accounts/import' && req.method === 'POST') {
      const accId = u.searchParams.get('account');
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!accId || !accounts.list().find((a) => a.id === accId)) {
        return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      }
      if (!name || !ACCFILE_EXT.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужен файл .zip (TDATA или session+json) или .session' });
      }
      let buf;
      try { buf = await rawBody(req); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      if (!buf.length) return json(res, 200, { ok: false, reason: 'файл пустой' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      const dest = path.join(UPLOADS, `${accId}-${name.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`);
      fs.writeFileSync(dest, buf);
      push(`\n↑ сессия для «${accId}»: ${name} (${Math.round(buf.length / 1024)} КБ)`);
      await freshIpForLogin();
      return json(res, 200, importAccount(accId, dest));
    }

    /**
     * Профиль аккаунта: имя, фамилия, «о себе», @username, аватарка.
     * Меняем тем же ключом, которым работает панель, — в браузер сессию
     * MTProto не перенести, там пришлось бы входить заново по QR.
     */
    if (u.pathname === '/api/accounts/profile' && req.method === 'POST') {
      const { id, name, last, about, username, dropPhotos } = await body(req);
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      if (running.has(id)) return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят' });
      if (!accounts.hasSession(acc)) return json(res, 200, { ok: false, reason: 'аккаунт не вошёл' });
      const args = [path.join(CODE, 'profile.py'), '--account', id];
      for (const [k, v] of [['name', name], ['last', last], ['about', about], ['username', username]]) {
        if (v !== undefined && v !== null) args.push(`--${k}`, String(v));
      }
      // чужие фотографии прежнего хозяина: новая аватарка их не отменяет
      if (dropPhotos) args.push('--drop-photos');
      run(id, acc.title, `Профиль — ${acc.title}`, pythonCmd(), args);
      return json(res, 200, { ok: true });
    }

    // Канал-прокладка: свой публичный канал аккаунта в профиле, в нём закреплённый
    // пост со ссылкой на основной канал. off — убрать канал из профиля.
    if (u.pathname === '/api/accounts/channel' && req.method === 'POST') {
      const { id, title, username, post, off } = await body(req);
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      if (running.has(id)) return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят — попробуй через минуту' });
      if (!accounts.hasSession(acc)) return json(res, 200, { ok: false, reason: 'аккаунт не вошёл' });
      const uname = String(username || '').trim().replace(/^@/, '');
      if (uname && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(uname)) {
        return json(res, 200, { ok: false, reason: 'ник канала: 5–32 знака, латиница, цифры и _, первая — буква' });
      }
      const args = [path.join(CODE, 'profile.py'), '--account', id];
      if (off) args.push('--channel-off');
      else {
        if (!acc.channelId && !String(title || '').trim()) return json(res, 200, { ok: false, reason: 'нужно название канала' });
        if (String(title || '').trim()) args.push('--channel-title', String(title).trim().slice(0, 128));
        if (uname) args.push('--channel-username', uname);
        if (String(post || '').trim()) args.push('--channel-post', String(post).trim().slice(0, 4000));
      }
      run(id, acc.title, `Канал в профиле — ${acc.title}`, pythonCmd(), args);
      return json(res, 200, { ok: true });
    }

    if (u.pathname === '/api/accounts/photo' && req.method === 'POST') {
      const id = u.searchParams.get('account');
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      if (running.has(id)) return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят' });
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!name || !/\.(jpg|jpeg|png|webp)$/i.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужна картинка .jpg или .png' });
      }
      let buf;
      try { buf = await rawBody(req, 12 * 1024 * 1024); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      fs.mkdirSync(UPLOADS, { recursive: true });
      const dest = path.join(UPLOADS, `avatar-${id}-${name.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`);
      fs.writeFileSync(dest, buf);
      push(`\n🖼 аватарка для «${acc.title}»: ${name}`);
      run(id, acc.title, `Аватарка — ${acc.title}`, pythonCmd(),
          [path.join(CODE, 'profile.py'), '--account', id, '--photo', dest]);
      return json(res, 200, { ok: true });
    }

    // одно описание/имя ВСЕМ вошедшим аккаунтам сразу
    if (u.pathname === '/api/accounts/profile-all' && req.method === 'POST') {
      const { about, name, last } = await body(req);
      const list = accounts.list().filter((a) => accounts.hasSession(a) && !running.has(a.id));
      if (!list.length) return json(res, 200, { ok: false, reason: 'нет свободных вошедших аккаунтов' });
      for (const acc of list) {
        const args = [path.join(CODE, 'profile.py'), '--account', acc.id];
        for (const [k, v] of [['name', name], ['last', last], ['about', about]]) {
          if (v !== undefined && v !== null && String(v).length) args.push(`--${k}`, String(v));
        }
        run(acc.id, acc.title, `Профиль (всем) — ${acc.title}`, pythonCmd(), args);
      }
      push(`\n👥 задаю профиль всем: ${list.length} аккаунт(ов)`);
      return json(res, 200, { ok: true, n: list.length });
    }

    // одну аватарку ВСЕМ вошедшим аккаунтам сразу
    if (u.pathname === '/api/accounts/photo-all' && req.method === 'POST') {
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!name || !/\.(jpg|jpeg|png|webp)$/i.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужна картинка .jpg или .png' });
      }
      let buf;
      try { buf = await rawBody(req, 12 * 1024 * 1024); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      const list = accounts.list().filter((a) => accounts.hasSession(a) && !running.has(a.id));
      if (!list.length) return json(res, 200, { ok: false, reason: 'нет свободных вошедших аккаунтов' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      const dest = path.join(UPLOADS, `avatar-all-${Date.now()}-${name.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`);
      fs.writeFileSync(dest, buf);
      for (const acc of list) {
        run(acc.id, acc.title, `Аватарка (всем) — ${acc.title}`, pythonCmd(),
            [path.join(CODE, 'profile.py'), '--account', acc.id, '--photo', dest]);
      }
      push(`\n🖼 ставлю одну аватарку всем: ${list.length} аккаунт(ов) — ${name}`);
      return json(res, 200, { ok: true, n: list.length });
    }

    /**
     * Открыть аккаунт в Telegram Desktop.
     *
     * tdata — родной формат Telegram Desktop, поэтому аккаунт там открывается
     * по-настоящему (в отличие от браузера, которому ключ MTProto не подходит).
     * Но ключ у десктопа и у панели ОДИН: если десктоп сходит в Telegram с
     * твоего настоящего IP, а панель ходит через прокси, Telegram увидит одну
     * авторизацию из двух стран — это первая причина, по которой сессии
     * отзывают. Поэтому запуск в два шага:
     *
     *   1) «Подготовить» — десктоп стартует на ПУСТОЙ папке, без аккаунта.
     *      Светить нечего. Человек прописывает прокси и закрывает окно.
     *   2) «Открыть» — только теперь кладём tdata рядом с уже настроенным
     *      прокси и запускаем снова. Аккаунт выходит в сеть сразу через прокси.
     */
    if (u.pathname === '/api/accounts/desktop' && req.method === 'POST') {
      const { id, step } = await body(req);
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });

      const app = tdesktopApp();
      if (!app) return json(res, 200, { ok: false, need: 'tdesktop', reason: TDESK_HINT });

      const wd = path.join(DESKTOP, id);
      fs.mkdirSync(wd, { recursive: true });
      const proxyMark = path.join(wd, '.proxy-ok');

      if (step === 'proxy') {
        // на всякий случай убираем аккаунт из папки: шаг 1 должен быть пустым
        fs.rmSync(path.join(wd, 'tdata'), { recursive: true, force: true });
        launchDesktop(app, wd);
        push(`\n🖥 «${acc.title}»: десктоп открыт ПУСТЫМ — пропиши прокси и закрой окно`);
        return json(res, 200, { ok: true, step: 'proxy',
          proxy: accounts.proxyLabel(acc.proxy) });
      }

      // шаг 2 — кладём tdata
      const src = fs.existsSync(UPLOADS)
        ? fs.readdirSync(UPLOADS).find((f) => f.startsWith(`${id}-`) && /\.zip$/i.test(f))
        : null;
      if (!src) {
        return json(res, 200, { ok: false, reason:
          'Не нашёл исходный файл сессии в uploads/. Открыть в десктопе можно только ' +
          'аккаунт, залитый как TDATA (.zip). Перезалей его кнопкой «Сессия».' });
      }
      try {
        unpackTdata(path.join(UPLOADS, src), wd, DESKTOP);
      } catch (e) {
        return json(res, 200, { ok: false, reason: 'не смог достать tdata: ' + e.message });
      }
      launchDesktop(app, wd);
      push(`\n🖥 «${acc.title}» открыт в Telegram Desktop (своя папка: desktop/${id})`);
      return json(res, 200, { ok: true, step: 'open',
        warmed: fs.existsSync(proxyMark), proxy: accounts.proxyLabel(acc.proxy) });
    }

    /**
     * Пачкой: собираем ОДНУ папку tdata сразу с несколькими аккаунтами, чтобы
     * в Telegram Desktop переключаться между ними по аватарке. Больше трёх в
     * одну папку не влезет — это ограничение самого десктопа.
     */
    if (u.pathname === '/api/accounts/desktop/pack' && req.method === 'POST') {
      const { ids, step } = await body(req);
      const app = tdesktopApp();
      if (!app) return json(res, 200, { ok: false, need: 'tdesktop', reason: TDESK_HINT });
      if (running.has('_pack')) return json(res, 200, { ok: false, reason: 'сборка уже идёт' });

      const wd = path.join(DESKTOP, 'pack');
      fs.mkdirSync(wd, { recursive: true });

      if (step === 'proxy') {
        fs.rmSync(path.join(wd, 'tdata'), { recursive: true, force: true });
        launchDesktop(app, wd);
        push('\n🖥 общий десктоп открыт ПУСТЫМ — пропиши прокси и закрой окно');
        return json(res, 200, { ok: true, step: 'proxy' });
      }

      const chosen = (Array.isArray(ids) ? ids : []).filter((id) => {
        const a = accounts.list().find((x) => x.id === id);
        return a && accounts.hasSession(a);
      }).slice(0, 3);
      if (!chosen.length) return json(res, 200, { ok: false, reason: 'не выбран ни один вошедший аккаунт' });

      push(`\n🖥 собираю общую папку Telegram Desktop: ${chosen.map(title).join(', ')}`);
      run('_pack', 'десктоп', 'Сборка папки Telegram Desktop', pythonCmd(),
          [path.join(CODE, 'desktop-pack.py'), '--accounts', chosen.join(','), '--out', wd],
          (code) => {
            if (code === 0) { launchDesktop(app, wd); push('🖥 общий десктоп запущен'); }
            else push('🖥 собрать папку не вышло — смотри строки выше');
          });
      return json(res, 200, { ok: true, step: 'open', n: chosen.length });
    }

    /**
     * Комплект запуска аккаунта на СВОЁМ компьютере.
     *
     * Панель крутится на сервере и запустить Telegram Desktop у человека не
     * может. Поэтому отдаём архив: tdata аккаунта, мост до его прокси и один
     * запускаемый файл под нужную систему. Прокси можно передать свой —
     * пригодится, когда аккаунт смотрят с другого IP, чем работает панель.
     */
    /**
     * Устройства аккаунта: кто сейчас имеет к нему доступ и кого выгнать.
     * Ходим в Telegram через прокси аккаунта, поэтому это обычная задача —
     * пока на аккаунте работает прогон, ждём его очереди.
     */
    if (u.pathname === '/api/accounts/devices') {
      const post = req.method === 'POST' ? await body(req) : {};
      const id = u.searchParams.get('id') || post.id || '';
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      if (running.has(id) || accessBusy.has(id)) return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят — подожди' });
      const kill = post.kill || '';
      const args = [path.join(CODE, 'access.py'), '--account', id];
      if (kill === 'others') args.push('--kill-others');
      else if (kill) args.push('--kill', String(kill));
      else args.push('--list');
      accessBusy.add(id);     // на время запроса прогон этот аккаунт не трогает
      try {
        const out = execFileSync(pythonCmd(), args,
          { cwd: CODE, env: { ...process.env, TG_PANEL_DIR: DIR }, encoding: 'utf8', timeout: 180_000 });
        const line = out.trim().split('\n').filter((l) => l.trim().startsWith('[')).pop() || '[]';
        return json(res, 200, { ok: true, devices: JSON.parse(line) });
      } catch (e) {
        return json(res, 200, { ok: false, reason: (e.stderr || e.message || '').split('\n').pop() || 'не вышло' });
      } finally {
        accessBusy.delete(id);
      }
    }

    /**
     * «Пульт» — один архив на несколько аккаунтов, у каждого свой отдельный
     * вход. Собираем входы по очереди: это обращения в Telegram через прокси,
     * поэтому заодно проверяем, что аккаунты сейчас не заняты задачей.
     */
    if (u.pathname === '/api/accounts/pult') {
      const ids = (u.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return json(res, 200, { ok: false, reason: 'не выбрано ни одного аккаунта' });
      const pultOs = ['mac', 'win', 'linux'].includes(u.searchParams.get('os')) ? u.searchParams.get('os') : 'win';
      const busy = ids.filter((id) => running.has(id) || accessBusy.has(id));
      if (busy.length) {
        return json(res, 200, { ok: false,
          reason: `заняты: ${busy.map(title).join(', ')} — подожди минуту` });
      }
      const proxyParam = u.searchParams.get('proxy');   // «нет» — напрямую; иначе прокси аккаунта/свой
      fs.mkdirSync(DESKTOP, { recursive: true });
      const parts = [], tmp = [], failed = [];
      for (const id of ids) {
        const acc = accounts.list().find((a) => a.id === id);
        if (!acc) { failed.push(`${id}: не найден`); continue; }
        let proxy = null;
        if (proxyParam !== 'нет') {
          try { proxy = kitProxy(accounts.parseProxy(proxyParam || acc.proxy)); }
          catch (e) { failed.push(`${acc.title}: ${e.message}`); continue; }
        }
        const dir = path.join(DESKTOP, `pult-${id}-${Date.now()}`);
        accessBusy.add(id);     // пока создаём вход — прогон этот аккаунт не берёт
        try {
          execFileSync(pythonCmd(), [path.join(CODE, 'access.py'), '--account', id, '--out', dir],
            { cwd: CODE, env: { ...process.env, TG_PANEL_DIR: DIR }, encoding: 'utf8', timeout: 240_000 });
          tmp.push(dir);
          parts.push({ id, title: acc.name || acc.title, proxy, tdataDir: dir });
        } catch (e) {
          fs.rmSync(dir, { recursive: true, force: true });
          failed.push(`${acc.title}: ${String(e.stdout || e.stderr || e.message).trim().split('\n').pop()}`);
        } finally {
          accessBusy.delete(id);
        }
      }
      if (!parts.length) {
        return json(res, 200, { ok: false, reason: 'ни один вход не создан — ' + failed.join(' | ') });
      }
      let pult;
      try { pult = buildPult({ accounts: parts, kitDir: path.join(CODE, 'kit'), os: pultOs }); }
      catch (e) { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
                  return json(res, 200, { ok: false, reason: 'не собрался пульт: ' + e.message }); }
      for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
      push(`\n🖥 собран ПУЛЬТ на ${parts.length} акк. — у каждого отдельный вход` +
           (failed.length ? ` · не вошли: ${failed.length}` : ''));
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${pult.name}"`,
        'content-length': pult.body.length,
        'cache-control': 'no-store',
        'x-skipped': String(failed.length),
      });
      return res.end(pult.body);
    }

    if (u.pathname === '/api/accounts/kit') {
      const id = u.searchParams.get('id') || '';
      const os = ['mac', 'win', 'linux'].includes(u.searchParams.get('os'))
        ? u.searchParams.get('os') : 'mac';
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 404, { ok: false, reason: 'аккаунт не найден' });

      // Облачный пароль (2FA) для отдельного входа приходит телом POST, а не в
      // адресе — чтобы не попасть в логи/историю. Дальше отдаём его access.py
      // через окружение, тоже мимо аргументов командной строки.
      let cloudPass = '';
      if (req.method === 'POST') { try { cloudPass = String((await body(req)).password || ''); } catch {} }

      // «Напрямую» — комплект без моста: аккаунт открывается сразу, а каким
      // адресом он выйдет, решает сам компьютер (обычно VPN у человека).
      const direct = u.searchParams.get('proxy') === 'нет';
      let proxy = null;
      if (!direct) {
        try {
          const parsed = accounts.parseProxy(u.searchParams.get('proxy') || acc.proxy);
          if (!parsed) throw new Error('у аккаунта не задан прокси — без него аккаунт выйдет с твоего IP');
          proxy = kitProxy(parsed);
        } catch (e) {
          return json(res, 200, { ok: false, reason: e.message });
        }
      }

      const src = fs.existsSync(UPLOADS)
        ? fs.readdirSync(UPLOADS).find((f) => f.startsWith(`${id}-`) && /\.zip$/i.test(f))
        : null;
      if (!src) {
        return json(res, 200, { ok: false, reason:
          'Не нашёл исходный файл сессии в uploads/. Открыть на компьютере можно только ' +
          'аккаунт, залитый как TDATA (.zip). Перезалей его кнопкой «Сессия».' });
      }

      /**
       * Отдельный вход. Панель создаёт аккаунту ВТОРУЮ авторизацию и кладёт
       * в комплект её, а не свой ключ. Такой комплект можно отозвать из
       * панели одной кнопкой, и человеку больше нельзя случайно «выйти»
       * так, чтобы это убило аккаунт.
       */
      let freshDir = '';
      if (u.searchParams.get('fresh') === '1') {
        if (running.has(id) || accessBusy.has(id)) {
          return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят — подожди минуту' });
        }
        freshDir = path.join(DESKTOP, `fresh-${id}-${Date.now()}`);
        accessBusy.add(id);     // пока создаём вход — прогон этот аккаунт не берёт
        try {
          fs.mkdirSync(DESKTOP, { recursive: true });
          execFileSync(pythonCmd(), [path.join(CODE, 'access.py'), '--account', id, '--out', freshDir],
            { cwd: CODE, env: { ...process.env, TG_PANEL_DIR: DIR, TG_CLOUD_PASS: cloudPass },
              encoding: 'utf8', timeout: 240_000 });
        } catch (e) {
          fs.rmSync(freshDir, { recursive: true, force: true });
          const why = String(e.stdout || e.stderr || e.message || '').trim().split('\n').pop();
          return json(res, 200, { ok: false, reason: why || 'не вышло создать отдельный вход' });
        } finally {
          accessBusy.delete(id);
        }
      }

      // Ключ панели, а архив аккаунта залит как Telethon-сессия (.session), а не
      // tdata — паковать в комплект нечего. Собираем tdata из живой сессии тем же
      // ключом (без нового входа и без 2FA). Для отдельного входа это не нужно:
      // там tdata берётся из свежесозданной авторизации (freshDir).
      let keyDir = '';
      if (!freshDir && !zipHasTdata(path.join(UPLOADS, src))) {
        if (running.has(id) || accessBusy.has(id)) {
          return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят — подожди минуту' });
        }
        keyDir = path.join(DESKTOP, `key-${id}-${Date.now()}`);
        accessBusy.add(id);
        try {
          fs.mkdirSync(DESKTOP, { recursive: true });
          execFileSync(pythonCmd(), [path.join(CODE, 'access.py'), '--account', id, '--tdata-current', keyDir],
            { cwd: CODE, env: { ...process.env, TG_PANEL_DIR: DIR }, encoding: 'utf8', timeout: 180_000 });
        } catch (e) {
          fs.rmSync(keyDir, { recursive: true, force: true });
          const why = String(e.stdout || e.stderr || e.message || '').trim().split('\n').pop();
          return json(res, 200, { ok: false, reason: why || 'не смог собрать tdata из ключа панели' });
        } finally {
          accessBusy.delete(id);
        }
      }

      let kit;
      try {
        fs.mkdirSync(DESKTOP, { recursive: true });
        kit = buildKit({ id, title: acc.name || acc.title, proxy, os, kitDir: path.join(CODE, 'kit'),
                         uploadsZip: path.join(UPLOADS, src), tdataDir: freshDir || keyDir || '', tmpRoot: DESKTOP });
      } catch (e) {
        fs.rmSync(freshDir, { recursive: true, force: true });
        fs.rmSync(keyDir, { recursive: true, force: true });
        return json(res, 200, { ok: false, reason: 'не смог собрать комплект: ' + e.message });
      }
      // ключ уже внутри архива — на сервере ему делать нечего
      if (freshDir) fs.rmSync(freshDir, { recursive: true, force: true });
      if (keyDir) fs.rmSync(keyDir, { recursive: true, force: true });
      push(`\n🖥 «${acc.title}»: собран комплект запуска на компьютере (${os})` +
           (freshDir ? ' — с отдельным входом, его видно в «Устройствах»' : ''));
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${kit.name}"`,
        'content-length': kit.body.length,
        'cache-control': 'no-store',
      });
      return res.end(kit.body);
    }

    if (u.pathname === '/api/accounts/desktop/ready' && req.method === 'POST') {
      const { id } = await body(req);
      const wd = path.join(DESKTOP, id);
      fs.mkdirSync(wd, { recursive: true });
      fs.writeFileSync(path.join(wd, '.proxy-ok'), new Date().toISOString());
      return json(res, 200, { ok: true });
    }

    if (u.pathname === '/api/accounts/remove' && req.method === 'POST') {
      const { id } = await body(req);
      if (running.has(id)) return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят' });
      const acc = accounts.list().find((a) => a.id === id);
      claims.releaseAll(id);
      const ok = accounts.remove(id);
      if (ok) push(`− аккаунт «${acc.title}» отключён, его сессия удалена`);
      return json(res, 200, { ok });
    }

    if (u.pathname === '/api/accounts/proxy' && req.method === 'POST') {
      const { id, proxy, all } = await body(req);
      // один мобильный прокси на всех — обычное дело, и прокликивать его
      // по каждому аккаунту руками незачем
      if (all) {
        const ids = accounts.list().map((a) => a.id);
        for (const one of ids) {
          // строка у всех одна, поэтому первая же ошибка — общая: незачем
          // повторять её столько раз, сколько заведено аккаунтов
          try { accounts.setProxy(one, proxy); accounts.setField(one, { proxyOwn: false }); }
          catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
        }
        push(`⚙ прокси ${accounts.proxyLabel(proxy)} поставлен всем аккаунтам (${ids.length})`);
        const warn = accounts.proxyWarning(proxy);
        if (warn) push(`⚠ ${warn}`);
        return json(res, 200, { ok: true, warn });
      }
      try {
        const ok = accounts.setProxy(id, proxy);
        // руками поставили строку — она больше не «своя» от раздачи: сторож
        // не должен её возвращать, и откат на общий прокси так работает
        if (ok) accounts.setField(id, { proxyOwn: false });
        const acc = accounts.list().find((a) => a.id === id);
        const warn = accounts.proxyWarning(acc.proxy);
        if (ok) push(`⚙ «${acc.title}» ходит через: ${accounts.proxyLabel(acc.proxy)}`);
        if (warn) push(`⚠ ${warn}`);
        return json(res, 200, { ok, warn });
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message });
      }
    }

    // «Свой IP каждому»: отдельная мобильная сессия Asocks на аккаунт (server/ownproxy.mjs).
    // down — только тем, у кого прокси сейчас лежит или ещё общий. Идёт в фоне:
    // каждая сессия проверяется (IP, страна, доступ к Telegram) — это минуты.
    if (u.pathname === '/api/proxy/own' && req.method === 'POST') {
      const { ids, down, country } = await body(req);
      if (!asocks.enabled()) return json(res, 200, { ok: false, reason: 'Asocks не подключён: на сервере нет ключа API' });
      if (ownProxy.busy()) return json(res, 200, { ok: false, reason: 'раздача уже идёт — дождись её' });
      let list = accounts.list().filter((a) => accounts.hasSession(a));
      if (Array.isArray(ids) && ids.length) list = list.filter((a) => ids.includes(a.id));
      // «2»: общий прокси, лежит или своя строка старого вида (готовая сессия без «-session-»)
      if (down) list = list.filter((a) => !a.proxyOwn || proxyGuard.down(a.proxy) || !/-session-/.test(a.proxy || ''));
      if (!list.length) return json(res, 200, { ok: false, reason: down ? 'у всех уже свой живой IP' : 'нет вошедших аккаунтов' });
      const cc = /^[A-Z]{2}$/.test(String(country || '')) ? country : 'KZ';
      push(`\n🌐 свой IP каждому: ${list.length} акк., своя постоянная строка Asocks (${cc}, регион + своя сессия) — проверяю по одной`);
      ownProxy.assign({ ids: list.map((a) => a.id), country: cc }).then((r) => {
        const ok = r.filter((x) => x.ok).length;
        push(`🌐 готово: свой IP у ${ok} из ${r.length}` + (ok < r.length
          ? '. Не вышло: ' + r.filter((x) => !x.ok).map((x) => `${x.id} — ${x.why}`).join('; ') : '') +
          (ok && auto.on && auto.serial ? '. Прогон всё ещё идёт по одному — перезапусти его, чтобы пошёл параллельно' : ''));
        events.note('🌐', `свой IP получили ${ok} из ${r.length} аккаунтов`);
      }).catch((e) => push(`🌐 раздача не удалась: ${e.message}`));
      return json(res, 200, { ok: true, n: list.length });
    }

    if (u.pathname === '/api/accounts/rename' && req.method === 'POST') {
      const { id, title } = await body(req);
      return json(res, 200, { ok: accounts.rename(id, title) });
    }

    /* ───────── БАЗА ПОЛУЧАТЕЛЕЙ — набор, загрузка, участники чатов ───────── */

    /** Какой набор получателей в работе: «по номерам» или «по чатам». */
    if (u.pathname === '/api/base-set') {
      if (req.method !== 'POST') return json(res, 200, { set: baseSet });
      const { set } = await body(req);
      if (set !== 'phones' && set !== 'chats') return json(res, 200, { ok: false, reason: 'нет такого режима' });
      // Прогону это теперь безразлично: набор у каждого аккаунта свой, он
      // задаётся при запуске режима. Общий остаётся только для экранов —
      // какую базу и какие результаты смотрит человек. А вот ручные задачи
      // посреди работы переключать нельзя: допишут половину в другой набор.
      const busy = [...running.values()].some((v) =>
        /^(Проверка базы|Черновики|Смотрит ответы|Загрузка базы)/.test(v.title));
      if (busy && set !== baseSet) {
        return json(res, 200, { ok: false, reason: 'сейчас идёт задача по текущему набору — дождись её' });
      }
      setBaseSet(set);
      return json(res, 200, { ok: true, set: baseSet });
    }

    if (u.pathname === '/api/base') {
      const rows = readCsv('numbers.csv');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(BASEMETA, 'utf8')); } catch {}
      return json(res, 200, {
        count: rows.length, file: meta.file || '', at: meta.at || '',
        loading: running.has('_base'),
        rows: rows.slice(0, 8).map((r) => ({ phone: r.phone, calls: r.calls, last_call: r.last_call })),
      });
    }

    /**
     * Разбор чата: сколько людей собрано, из каких чатов и что с ними стало.
     * Это второй способ набрать получателей — вместо таблицы с номерами;
     * очередь на рассылку у них дальше общая с проверенными номерами.
     */
    if (u.pathname === '/api/members') {
      const rows = readCsv('members.csv');
      // какие чаты уже пройдены до конца — это помнит parse-chat.py,
      // чтобы следующий заход начинался с неразобранных
      let walked = {};
      try { walked = JSON.parse(fs.readFileSync(path.join(DIR, 'chats.json'), 'utf8')) || {}; }
      catch {}
      const found = readCsv('results.csv');
      const log = readCsv('drafts.csv');
      const queued = found.filter((r) => !isPhone(r.phone) && r.tg === 'true');
      const done = new Set(log.filter((r) => r.ok === 'true' || r.sent === 'true').map((r) => r.phone));
      const byChat = new Map();
      for (const r of rows) byChat.set(r.chat || '—', (byChat.get(r.chat || '—') || 0) + 1);
      return json(res, 200, {
        count: rows.length,
        named: rows.filter((r) => r.username).length,
        queued: queued.length,
        written: queued.filter((r) => done.has(r.phone)).length,
        // кому напишет любой аккаунт, а кому — только тот, кто его нашёл
        solo: queued.filter((r) => String(r.phone).startsWith('id:')).length,
        parsing: [...running.values()].some((v) => v.title.startsWith('Разбор чат')),
        walked: Object.keys(walked).length,
        chats: [...byChat].map(([title, n]) => ({ title, n })).sort((a, b) => b.n - a.n).slice(0, 8),
        rows: rows.slice(-8).reverse().map((r) => ({
          key: r.key, name: r.name || '', chat: r.chat || '',
        })),
      });
    }

    /** Собранных людей можно забрать файлом — открывается в Excel. */
    if (u.pathname === '/api/members/csv') {
      const file = path.join(DIR, 'members.csv');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'участников ещё не собирали' });
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="members.csv"',
        'cache-control': 'no-store',
      });
      // BOM: без него Excel открывает наши имена крокозябрами
      return res.end('\ufeff' + fs.readFileSync(file, 'utf8'));
    }

    /** Найденные в Telegram — файлом по запросу (в панели список не выводим). */
    if (u.pathname === '/api/found/csv') {
      const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const dr = readCsv('drafts.csv');
      const drafted = new Set(dr.filter((r) => r.ok === 'true').map((r) => r.phone));
      const sent = new Set(dr.filter((r) => r.sent === 'true').map((r) => r.phone));
      const rows = readCsv('results.csv').filter((r) => r.tg === 'true');
      const head = 'phone,name,last_call,источник,статус';
      const body = rows.map((r) => {
        const src = isPhone(r.phone) ? 'база (xlsx)' : 'чат (парсинг)';
        const st = sent.has(r.phone) ? 'отправлено' : drafted.has(r.phone) ? 'черновик' : '';
        return [r.phone, r.name || '', (r.last_call || '').slice(0, 10), src, st].map(cell).join(',');
      }).join('\n');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="found.csv"',
        'cache-control': 'no-store',
      });
      return res.end('﻿' + head + '\n' + body);
    }

    if (u.pathname === '/api/upload' && req.method === 'POST') {
      // имя файла приходит заголовком: тело — сам файл, без multipart-обёртки
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!name || !BASE_EXT.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужен файл .xlsx, .xlsm, .csv или .tsv' });
      }
      let buf;
      try { buf = await rawBody(req); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      if (!buf.length) return json(res, 200, { ok: false, reason: 'файл пустой' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, '_');
      const dest = path.join(UPLOADS, safe);
      fs.writeFileSync(dest, buf);
      push(`\n↑ файл принят: ${safe} (${Math.round(buf.length / 1024)} КБ)`);
      return json(res, 200, loadBase(dest));
    }

    /* ───────── ТЕКСТЫ ПИСЕМ И ГОЛОСОВОЕ ───────── */

    /**
     * Текст рассылки правится прямо в панели: message.txt открывать руками
     * неудобно, а ошибиться в нём дороже всего — он уходит людям.
     */
    if (u.pathname === '/api/message') {
      // second=1 — текст ВТОРОГО письма: то, где ссылка. Оно уходит только
      // тем, кто ответил на первое, поэтому и живёт отдельным файлом.
      // aud=chat — отдельный текст для собранных ИЗ ЧАТОВ (у них нет номера);
      // база из xlsx получает message.txt, парсинг — message-chat.txt (если задан).
      const aud = u.searchParams.get('aud');
      const file = path.join(DIR,
        u.searchParams.get('second') ? 'message2.txt'
        : aud === 'chat' ? 'message-chat.txt'
        // запасной для чатов — тем, у кого нет полей таблицы (бренда) для основного
        : aud === 'chat-plain' ? 'message-chat-plain.txt'
        : 'message.txt');
      if (req.method !== 'POST') {
        return json(res, 200, { text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' });
      }
      const { text } = await body(req);
      const clean = fixPlaceholders(String(text ?? '').replace(/\r\n/g, '\n')).trim();
      // текст для чатов можно очистить — это значит «слать им общий текст»
      if (!clean && aud !== 'chat' && aud !== 'chat-plain') return json(res, 200, { ok: false, reason: 'текст не может быть пустым' });
      // предел одного сообщения в Telegram — 4096 символов; с запасом на подстановки
      if (clean.length > 3900) {
        return json(res, 200, { ok: false, reason: `слишком длинно: ${clean.length} символов, можно до 3900` });
      }
      fs.writeFileSync(file, clean ? clean + '\n' : '');
      const label = u.searchParams.get('second') ? 'второго письма'
        : aud === 'chat' ? 'сообщения для собранных из чатов'
        : aud === 'chat-plain' ? 'запасного сообщения для чатов (без бренда)' : 'сообщения';
      push(`\n✎ текст ${label} изменён (${clean.length} символов)`);
      return json(res, 200, { ok: true, text: clean });
    }

    /**
     * Голосовое для рассылки. GET — что сейчас лежит; POST — загрузка (файл
     * телом, имя заголовком, как у базы); отдельная отдача файла для прослушки
     * в панели; удаление. Голосовое одно на всю рассылку, как и текст.
     */
    if (u.pathname === '/api/voice' && req.method !== 'POST') {
      const m = voiceMeta();
      return json(res, 200, {
        exists: fs.existsSync(VOICE) && !!m,
        name: m?.name || '', duration: m?.duration || 0,
      });
    }
    if (u.pathname === '/api/voice/file') {
      if (!fs.existsSync(VOICE)) return json(res, 404, { ok: false });
      res.writeHead(200, { 'content-type': 'audio/ogg', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(VOICE));
    }
    if (u.pathname === '/api/voice' && req.method === 'POST') {
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!name || !VOICE_EXT.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужен аудиофайл (.ogg, .mp3, .m4a, .wav…)' });
      }
      let buf;
      try { buf = await rawBody(req); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      if (!buf.length) return json(res, 200, { ok: false, reason: 'файл пустой' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      const tmp = path.join(UPLOADS, 'voice-src-' + name.replace(/[^\p{L}\p{N}._ -]/gu, '_'));
      fs.writeFileSync(tmp, buf);
      try {
        const m = makeVoice(tmp, name);
        push(`\n🎤 голосовое загружено: ${name} (${m.duration}с)`);
        return json(res, 200, { ok: true, name: m.name, duration: m.duration });
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message });
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    if (u.pathname === '/api/voice/delete' && req.method === 'POST') {
      try { fs.unlinkSync(VOICE); } catch {}
      try { fs.unlinkSync(VOICEMETA); } catch {}
      push('\n🎤 голосовое убрано');
      return json(res, 200, { ok: true });
    }

    /**
     * Чистка: аккаунты выходят из Telegram и пропадают из панели, данные
     * уезжают в бэкап-папку. Идёт в два шага, потому что выход из аккаунтов —
     * это работа по сети: сначала задача logout-accounts.py, потом уборка.
     * Панель ждать не заставляем — ход виден в журнале, готовность в /api/state.
     */
    if (u.pathname === '/api/reset' && req.method === 'POST') {
      if (running.has('_wipe')) {
        return json(res, 200, { ok: false, reason: 'чистка уже идёт' });
      }
      /**
       * Раньше чистка требовала, чтобы человек сам сначала всё остановил, и
       * отказывала, если хоть что-то ещё дышало. На деле «Остановить» убивает
       * процессы не мгновенно: нажав обе кнопки подряд, человек получал отказ
       * на ровном месте, жал ещё раз — и попадал в то же самое.
       *
       * Теперь чистка останавливает всё сама и ждёт, пока процессы действительно
       * умрут. Это её работа, а не человека.
       */
      if (auto.on) autoStop('идёт полная чистка');
      if (warmup.on) warmStop('идёт полная чистка');
      enrich.stop('идёт полная чистка');
      if (mirror.on) mirrorStop();
      // отвязать все субдомены проекта (режим api) — чтобы кабинет Vercel
      // не копил мусор; в wildcard отвязывать нечего
      if (mirror.mode === 'api' && mirror.token) {
        for (const m of mirror.pool.filter((x) => !x.retired)) {
          await vercel.deleteDomain(secret(), `${m.name}.${mirror.base}`);
        }
      }
      // забываем всё про зеркала: и токен, и пул. Иначе фоновая чистка
      // тут же перезапишет mirror.json, который чистка только что унесла
      Object.assign(mirror, { current: '', url: '', pool: [], sinceCount: 0, next: 0,
                              token: '', projectId: '', teamId: '' });
      if (running.size) {
        push('\n⏹ останавливаю задачи перед чисткой…');
        for (const [k, r] of running) { if (k !== '_wipe') r.child.kill('SIGTERM'); }
        // ждём до 20 секунд; кто не ушёл сам — добиваем
        for (let i = 0; i < 40 && running.size; i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
        for (const [k, r] of running) { if (k !== '_wipe') r.child.kill('SIGKILL'); }
        await new Promise((r) => setTimeout(r, 500));
      }
      // выходить не из кого — сразу убираем
      if (!accounts.list().length) return json(res, 200, { ok: true, ...wipeAll() });
      push('\n🧹 чистка: выхожу из аккаунтов, это займёт несколько секунд…');
      run('_wipe', 'чистка', 'Выход из всех аккаунтов', pythonCmd(),
          [path.join(CODE, 'logout-accounts.py')], () => wipeAll());
      return json(res, 200, { ok: true, started: true });
    }
    /* ───────── СОСТОЯНИЕ ПАНЕЛИ — счётчики, журнал, лента, результаты ───────── */


    if (u.pathname === '/api/state') {
      const now = counts();
      return json(res, 200, {
        running: [...running.values()].map((v) => v.title),
        // то же самое по-человечески: «Егор Кочнев — проверяет номера»
        doing: [...running.entries()].map(([key, v]) => {
          const acc = accounts.list().find((a) => a.id === key);
          const word = (TASK_WORD.find(([re]) => re.test(v.title)) || [null, v.title.split(' — ')[0]])[1];
          return acc ? `${acc.name || acc.title} — ${word}` : word;
        }),
        base: readCsv('numbers.csv').length,
        ...now,
        // числа за всё время: переживают чистку, поэтому считаются отдельно
        total: statsTotal(now),
        ...(() => { const r = replies(); return { replies: r.n, repliesCheckedAt: r.checkedAt, repliesChecksHour: r.checkedLastHour }; })(),
        baseLoading: running.has('_base'),
        baseSet,
        // своё по каждому набору — для полос «по номерам» и «по чатам»
        bySet: Object.fromEntries(SETS.map((s) =>
          [s, { base: readCsv('numbers.csv', s).length, ...countsOf[s]() }])),
        wiping: running.has('_wipe'),
        claims: claims.active().filter((h) => h.task !== 'parse'),
        proxy: proxyGuard.summary(),
        auto: autoView(),
        warmup: warmup.on,
        enrich: enrich.status(),
        mirror: mirror.on,
        logLen: log.length,
        // чей это профиль — панель за привратником показывает его в углу
        profile: process.env.TG_PROFILE || '',
        profileAdmin: !!process.env.TG_PROFILE_ADMIN,
      });
    }

    /**
     * Картинка QR для входа: её кладёт login-qr.py, пока ждёт скана.
     * Нет файла — значит кода сейчас нет (ещё не начали или уже вошли).
     */
    if (u.pathname === '/api/qr') {
      const id = u.searchParams.get('account') || '';
      const f = path.join(DIR, 'qr', `${path.basename(id)}.svg`);
      if (!/^[a-z0-9_-]+$/i.test(id) || !fs.existsSync(f)) return json(res, 404, { ok: false });
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(f));
    }

    /** Итоги рассылки для вкладки «Результаты» — по набору получателей. */
    if (u.pathname === '/api/results') {
      const set = u.searchParams.get('set') === 'chats' ? 'chats' : 'phones';
      const name = (id) => { const a = accounts.list().find((x) => x.id === id); return a ? (a.name || a.title) : id; };
      return json(res, 200, results.compute(set, name));
    }

    /** Переписка с ответившим целиком — вкладка «Результаты» тянет её при раскрытии. */
    if (u.pathname === '/api/talk') {
      const t = talksOf(u.searchParams.get('acc'))[u.searchParams.get('key') || ''];
      return json(res, 200, { msgs: t?.msgs || [] });
    }

    /** Лента событий — человеческим языком, свежие сверху. */
    if (u.pathname === '/api/events') {
      return json(res, 200, events.recent(Math.min(300, +(u.searchParams.get('n') || 100))));
    }

    if (u.pathname === '/api/log') {
      const from = Math.max(0, +(u.searchParams.get('from') || 0));
      return json(res, 200, { from, lines: log.slice(from), total: log.length });
    }

    if (u.pathname === '/api/replies') {
      return json(res, 200, replies());
    }

    /** Кто ответил на первое письмо и ещё не получил второе. */
    if (u.pathname === '/api/funnel') {
      const wrote = new Set(readAll('drafts.csv')
        .filter((r) => r.ok === 'true' || r.sent === 'true').map((r) => r.phone));
      const got = new Set(readCsv('followup.csv')
        .filter((r) => r.sent === 'true').map((r) => r.key));
      const file = path.join(DIR, 'message2.txt');
      return json(res, 200, {
        wrote: wrote.size,
        answered: got.size,                       // сколько уже дошло до второго шага
        hasText: fs.existsSync(file) && !!fs.readFileSync(file, 'utf8').trim(),
        on: auto.funnel,
      });
    }

    // «Проверить ответы сейчас»: сами проверяем раз в 2 часа днём, а когда
    // человек сел разбирать лидов — всем, кто писал людям, ставим проверку
    // немедленно. Идут по очереди тем же прогоном, через свои прокси.
    if (u.pathname === '/api/funnel/now' && req.method === 'POST') {
      if (!auto.on) {
        return json(res, 200, { ok: false, reason: 'прогон рассылки не запущен — ответы смотрит он. ' +
          'Без прогона: «Проверить, кто ответил» на вкладке рассылки' });
      }
      let n = 0;
      for (const [id, s] of auto.per) {
        if (!wroteAny().has(id) || accounts.fullRestLeft(accounts.list().find((a) => a.id === id))) continue;
        s.funnelAt = 1;            // в прошлом: возьмётся первым же тиком
        s.funnelNow = true;        // и без окна по часам
        n++;
      }
      push(`\n🔎 проверка ответов сейчас: ${n} акк. по очереди`);
      return json(res, 200, { ok: true, n });
    }

    if (u.pathname === '/api/found') {
      const rows = readCsv('drafts.csv');
      const drafted = new Set(rows.filter((r) => r.ok === 'true').map((r) => r.phone));
      const sent = new Set(rows.filter((r) => r.sent === 'true').map((r) => r.phone));
      return json(res, 200, readCsv('results.csv').filter((r) => r.tg === 'true')
        .map((r) => ({ phone: r.phone, name: r.name || '', last_call: r.last_call || '',
                       draft: drafted.has(r.phone), sent: sent.has(r.phone) })));
    }

    /**
     * Автопрогон: панель сама гоняет пачки всеми выбранными аккаунтами,
     * пока база не кончится. {on:false} — остановить.
     */
    /* ───────── ПРОКСИ, ЗЕРКАЛА И ЛИМИТЫ ───────── */

    /**
     * Проверка ссылки на смену IP: нажал — увидел, что ответил прокси.
     * Без этого настройку можно проверить только запуском прогона, а узнать,
     * что ссылка неверная, лучше до того, как аккаунты пойдут работать.
     */
    if (u.pathname === '/api/proxy/rotate' && req.method === 'POST') {
      const { url } = await body(req);
      const r = await rotateIp(String(url || '').trim());
      push(r.ok ? `\n🔄 проверка смены IP: прокси ответил ${r.text || 'ок'}`
                : `\n🔄 проверка смены IP: ${r.reason}`);
      return json(res, 200, r);
    }

    /**
     * Сборный текст: три блока, из каждого при отправке берётся одна строка.
     * Храним ровно то, что человек набрал, — разбор на строки дело отправки,
     * а править он должен то же, что видел.
     */
    if (u.pathname === '/api/parts') {
      const file = path.join(DIR, 'message-parts.json');
      const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
      const lines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);
      if (req.method !== 'POST') {
        const d = read();
        const n = ['hello', 'body', 'call'].map((k) => lines(d[k]).length);
        return json(res, 200, {
          on: !!d.on, hello: d.hello || '', body: d.body || '', call: d.call || '',
          counts: n, total: n.every((x) => x) ? n[0] * n[1] * n[2] : 0,
        });
      }
      const { on, hello, body: b, call } = await body(req);
      const clean = (t) => lines(t).join('\n');
      const next = { on: !!on, hello: clean(hello), body: clean(b), call: clean(call) };
      const n = ['hello', 'body', 'call'].map((k) => lines(next[k]).length);
      if (next.on && !n.every((x) => x)) {
        return json(res, 200, { ok: false, reason: 'для сборки нужны все три блока — хотя бы по строке в каждом' });
      }
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
      push(`\n✎ сборный текст: ${n.join(' × ')} = ${n[0] * n[1] * n[2]} непохожих сообщений` +
           (next.on ? '' : ' (сборка выключена)'));
      return json(res, 200, { ok: true, ...next, counts: n, total: n[0] * n[1] * n[2] });
    }

    /** Зеркала-субдомены: статус, вкл/выкл, настройки, ручная смена. */
    if (u.pathname === '/api/mirror') {
      if (req.method !== 'POST') return json(res, 200, mirrorView());
      const b = await body(req);
      if (typeof b.base === 'string' && b.base.trim()) mirror.base = b.base.trim().toLowerCase();
      if (b.mode === 'wildcard' || b.mode === 'api') mirror.mode = b.mode;
      if (Array.isArray(b.every) && b.every.length === 2) {
        const lo = num(b.every[0], 30, 1, 100000), hi = num(b.every[1], 50, lo, 200000);
        mirror.every = [lo, hi];
      }
      // токен и проект приходят только сюда и наружу не возвращаются
      if (typeof b.token === 'string' && b.token.trim()) {
        const t = b.token.trim();
        // токен Vercel — латиница; кириллица роняет заголовок HTTP невнятной ошибкой
        if (!/^[\x21-\x7e]+$/.test(t)) return json(res, 200, { ok: false, reason: 'токен Vercel — это латиница и цифры, проверь, что скопировал верно' });
        mirror.token = t;
      }
      if (typeof b.projectId === 'string') mirror.projectId = b.projectId.trim();
      if (typeof b.teamId === 'string') mirror.teamId = b.teamId.trim();
      if (b.on === true) mirrorStart();
      else if (b.on === false) mirrorStop();
      else mirrorSave();
      if (b.forceNew) { await mirrorRotate(); }
      return json(res, 200, { ok: true, ...mirrorView() });
    }

    /** Проверить токен Vercel и заодно, что домен привязан. */
    if (u.pathname === '/api/mirror/test' && req.method === 'POST') {
      if (!mirror.token || !mirror.projectId) {
        return json(res, 200, { ok: false, reason: 'сначала задай токен и ID проекта Vercel' });
      }
      const r = await vercel.ping(secret());
      push(r.ok ? `🪞 Vercel на связи: доменов в проекте ${r.count}`
                : `🪞 Vercel не принял: ${r.reason}`);
      return json(res, 200, r);
    }

    // сколько номеров в день может проверить один аккаунт (после разгона)
    if (u.pathname === '/api/checkcap' && req.method === 'POST') {
      const { cap } = await body(req);
      setCheckMax(Number(cap) || 0);
      warmSave();
      push(`\n🔎 максимум проверок номеров в день: ${getCheckMax()}`);
      return json(res, 200, { ok: true, cap: getCheckMax() });
    }

    /** Прогрев поведением: включить, выключить, посмотреть, кто чем занят. */
    // дневной предел сообщений «на всех»: 0 — авто по возрасту (прогрев)
    if (u.pathname === '/api/dailycap' && req.method === 'POST') {
      const { cap } = await body(req);
      setMaxCap(Number(cap) || 0);
      warmSave();
      push(`\n📊 максимум сообщений в день (плато): ${Number(cap) > 0 ? Number(cap) : 15}`);
      return json(res, 200, { ok: true, cap: getMaxCap() });
    }

    // роль: только прогрев или прогрев + рассылка
    if (u.pathname === '/api/accounts/role' && req.method === 'POST') {
      const { id, role, set: want } = await body(req);
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      // читатель (обогащение): только читает чаты — не греется, не пишет людям.
      // Из идущей рассылки уходит сразу, иначе прогон звал бы его к письмам
      if (role === 'read') {
        accounts.setField(id, { role: 'read' });
        if (auto.ids.includes(id)) {
          auto.ids = auto.ids.filter((x) => x !== id);
          auto.sets.delete(id);
          auto.per.delete(id);
        }
        events.note('📖', 'стал читателем: читает чаты для поиска лидов, людям не пишет', acc.title);
        return json(res, 200, { ok: true });
      }
      const send = role === 'send';
      // на отдыхе после заморозки в рассылку не переводим — ни кнопкой, ни
      // вопросом «взять в рассылку?» при запуске (так a1 вернулся 15.10)
      if (send && accounts.sendHoldLeft(acc)) {
        return json(res, 200, { ok: false, reason: `«${acc.title}» после заморозки без рассылки до ` +
          `${ekbDateTime(Date.now() + accounts.sendHoldLeft(acc))} по Екб — в рассылку не беру` });
      }
      accounts.setField(id, { role: send ? 'send' : 'warm' });
      // прогон уже идёт — новичок в рассылке подхватывается сразу, без перезапуска
      // Вкладка рассылки говорит, в какой режим его берут. Если этот режим уже
      // идёт — аккаунт подхватывается сразу, без перезапуска; если нет — просто
      // становится свободным, и его можно отметить галочкой.
      // Без набора (экран аккаунтов) в чужой прогон не суём: там не видно,
      // в какой из двух, а угадывать — значит отправить аккаунт не туда.
      if (send && SETS.includes(want) && auto.live[want] && !auto.ids.includes(id)
          && accounts.hasSession(acc) && accounts.isAuthed(acc)) {
        auto.ids.push(id);
        auto.sets.set(id, want);
        auto.per.set(id, autoPer((auto.opts[want]?.mode || 'full') !== 'check' && inQuarantine(acc)));
        restoreRest([id], auto.opts[want]);
      }
      events.note(send ? '✉️' : '🌱', send ? 'переведён в рассылку' : 'только прогрев — в рассылке не участвует', acc.title);
      return json(res, 200, { ok: true });
    }

    // дневной предел на ОДИН аккаунт (для тестов): сильнее общего; 0 — снять
    if (u.pathname === '/api/accounts/dailycap' && req.method === 'POST') {
      const { id, cap } = await body(req);
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      accounts.setField(id, { dailyCap: Math.max(0, Number(cap) || 0) });
      push(`\n📊 лимит «${acc.title}»: ${Number(cap) > 0 ? Number(cap) + ' в сутки' : 'как у всех'}`);
      return json(res, 200, { ok: true });
    }
    /* ───────── ПРОГРЕВ И АВТОПРОГОН — включение и настройки ───────── */


    // трафик: итог и баланс Asocks + «за что» по задачам и аккаунтам этого профиля
    if (u.pathname === '/api/traffic') {
      const names = Object.fromEntries(accounts.list().map((a) => [a.id, a.name || a.title]));
      // свой профиль видит и прод: его трафик лежит в папке основного профиля (= папка кода)
      let main = null, mainNames = {};
      if (DIR !== CODE) {
        main = trafficView(makeReadCsv(CODE));
        try {
          mainNames = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(CODE, 'accounts.json'), 'utf8'))
            .map((a) => [a.id, a.name || a.title]));
        } catch {}
      }
      return json(res, 200, { asocks: asocks.summary(), llm: llmUsage.summary(), tasks: trafficView(), names, main, mainNames });
    }

    /* ───────── КОММЕНТАРИИ В ЧАТАХ — очередь на одобрение и сводка ───────── */
    // Пишет comments.py (действие прогрева «comment»): журнал comments.csv,
    // очередь comments-pending.json, состояние чатов comment-plan.json.
    // Решения панели — в отдельном comments-decisions.json: его пишет ТОЛЬКО
    // панель, задачи только читают, поэтому общий файл с ними не делим.
    if (u.pathname === '/api/comments' && req.method !== 'POST') {
      const cfg = commentsCfg();
      const j = (f, d) => readJson(path.join(DIR, f)) ?? d;
      const pending = j('comments-pending.json', []);
      const dec = j('comments-decisions.json', {});
      const plan = j('comment-plan.json', {});
      const names = Object.fromEntries(accounts.list().map((a) => [a.id, a.name || a.title]));
      const rows = readRaw('comments.csv');
      const since = (h) => new Date(Date.now() - h * 3600e3).toISOString();
      const count = (st, h) => rows.filter((r) => r.status === st && r.at >= since(h)).length;
      const states = Object.values(plan);
      return json(res, 200, {
        on: !!cfg.on, held: cfg.held_accounts || [], approveFirst: cfg.approve_first ?? 50,
        reviewed: Object.values(dec).filter((v) => v && (v.ok === true || v.ok === false)).length,
        pending: (Array.isArray(pending) ? pending : []).filter((p) => p.status === 'pending')
          .map((p) => ({ ...p, decision: dec[p.id] || null, name: names[p.account] || p.account }))
          .slice(-50).reverse(),
        stats: { day: count('sent', 24), week: count('sent', 168), rejected: count('rejected', 168),
                 deleted: states.reduce((n, st) => n + (Number(st.deleted_total) || 0), 0) },
        chats: { total: states.length, assigned: states.filter((st) => st.account && !st.off).length,
                 off: states.filter((st) => st.off).length },
        recent: rows.filter((r) => r.status === 'sent').slice(-15).reverse()
          .map((r) => ({ at: r.at, name: names[r.account] || r.account, chat: r.chat, text: r.text, their: r.their })),
      });
    }
    if (u.pathname === '/api/comments/decide' && req.method === 'POST') {
      const { id, ok, text } = await body(req);
      const pending = readJson(path.join(DIR, 'comments-pending.json')) || [];
      const it = Array.isArray(pending) && pending.find((p) => p.id === id);
      if (!it) return json(res, 200, { ok: false, reason: 'комментарий не найден — обнови страницу' });
      const file = path.join(DIR, 'comments-decisions.json');
      const dec = readJson(file) || {};
      const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
      dec[id] = { ok: !!ok, at: new Date().toISOString(), ...(ok && t && t !== it.reply ? { text: t } : {}) };
      fs.writeFileSync(file + '.tmp', JSON.stringify(dec, null, 1) + '\n');
      fs.renameSync(file + '.tmp', file);
      push(`\n💬 комментарий ${ok ? 'одобрен' : 'отклонён'} (${it.account}, ${it.chat_title || it.chat})`);
      return json(res, 200, { ok: true });
    }

    // кого греем: список id (пусто — всех). Галочки на вкладке «Прогрев».
    if (u.pathname === '/api/warmup/crew' && req.method === 'POST') {
      const { ids } = await body(req);
      const all = accounts.list().map((a) => a.id);
      const sel = Array.isArray(ids) ? ids.filter((x) => all.includes(x)) : [];
      // отметили всех (или никого) — значит «греем всех», храним пустой список
      warmup.only = (sel.length === 0 || sel.length === all.length) ? [] : sel;
      warmSave();
      push(`\n🌱 прогрев: ${warmup.only.length ? 'только ' + warmup.only.length + ' выбранных' : 'все аккаунты'}`);
      return json(res, 200, { ok: true, only: warmup.only });
    }

    // ─── Лиды: обогащение — поиск чатов, сбор лидов, письма им ─────────────
    if (u.pathname === '/api/enrich' && req.method !== 'POST') return json(res, 200, enrich.view());
    if (u.pathname === '/api/enrich/leads.csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="leads.csv"',
        'cache-control': 'no-store',
      });
      return res.end(enrich.leadsCsv());
    }
    if (u.pathname.startsWith('/api/enrich/') && req.method === 'POST') {
      const o = await body(req);
      const what = u.pathname.slice('/api/enrich/'.length);
      if (what === 'keywords') return json(res, 200, enrich.makeKeywords(o.topic));
      if (what === 'keywords-save') return json(res, 200, enrich.saveKeywords(o.list));
      if (what === 'find') return json(res, 200, enrich.find(o.on !== false));
      if (what === 'chats') return json(res, 200, await enrich.addChats(o.list));
      if (what === 'chats-cmd') return json(res, 200, await enrich.chatsCmd(o.cmd, o.keys));
      if (what === 'goal') return json(res, 200, enrich.setGoal(o.goal));
      if (what === 'run') return json(res, 200, enrich.setOn(o.on !== false));
      // «Написать лидам» — обычный автопрогон по чатам, только по лидам.
      // Настройки (тексты, паузы, лимиты, кто пишет) — с вкладки «Рассылка по чатам»
      if (what === 'write') {
        if (!enrich.leadKeys().size) return json(res, 200, { ok: false, reason: 'лидов пока нет — сначала собери их' });
        if (auto.live.chats) {
          return json(res, 200, { ok: false, reason: auto.opts.chats?.leadsOnly
            ? 'рассылка лидам уже идёт' : 'сейчас идёт рассылка по чатам — останови её на вкладке «Рассылка по чатам», потом пиши лидам' });
        }
        return json(res, 200, autoStart({ ...o, set: 'chats', leadsOnly: true }));
      }
      return json(res, 200, { ok: false, reason: 'нет такого действия' });
    }

    // ─── Органика: вкладка управления коммент-движком ───────────────────────
    if (u.pathname === '/api/organic' && req.method !== 'POST') {
      const c = commentsCfg();
      const only = Array.isArray(c.only) ? c.only : [];
      let personas = [];
      try { personas = fs.readdirSync(path.join(DIR, 'personas')).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)); } catch {}
      const leads = readRaw('comment-leads.csv').slice(-30).reverse()
        .map((r) => ({ at: r.at, chat: r.chat, username: r.username, reason: r.reason, quote: r.quote }));
      const accs = accounts.list().map((a) => ({
        id: a.id, name: a.name || a.title, authed: accounts.isAuthed(a),
        persona: a.persona || '', reserve: !!a.reserve, retired: !!a.retired,
        inPool: only.length ? only.includes(a.id) : null,     // null — пул не задан (комментят все прогретые)
      }));
      return json(res, 200, { on: !!c.on, only, poolSet: only.length > 0, personas, accounts: accs, leads });
    }
    if (u.pathname === '/api/organic/comments' && req.method === 'POST') {
      const { on } = await body(req);
      writeCommentsCfg({ on: !!on });
      push(`\n💬 комментинг ${on ? 'включён' : 'выключен'} (Органика)`);
      return json(res, 200, { ok: true, on: !!on });
    }
    if (u.pathname === '/api/organic/pool' && req.method === 'POST') {
      const { ids } = await body(req);
      const all = accounts.list().map((a) => a.id);
      const sel = Array.isArray(ids) ? ids.filter((x) => all.includes(x)) : [];
      const only = (sel.length === 0 || sel.length === all.length) ? [] : sel;   // все/никто — пул не задан
      writeCommentsCfg({ only });
      push(`\n💬 коммент-пул: ${only.length ? only.length + ' аккаунтов' : 'все прогретые'}`);
      return json(res, 200, { ok: true, only });
    }
    if (u.pathname === '/api/organic/account' && req.method === 'POST') {
      const { id, persona, reserve } = await body(req);
      if (!accounts.list().some((a) => a.id === id)) return json(res, 200, { ok: false, reason: 'нет такого аккаунта' });
      const patch = {};
      if (persona !== undefined) patch.persona = String(persona || '').trim();
      if (reserve !== undefined) patch.reserve = !!reserve;
      if (Object.keys(patch).length) accounts.setField(id, patch);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/organic/discover' && req.method === 'POST') {
      const { account, seeds, niche, minSubs, score, limit, dry } = await body(req);
      let acc; try { acc = accounts.resolve(account); } catch { return json(res, 200, { ok: false, reason: 'выбери аккаунт-искатель' }); }
      if (!accounts.hasSession(acc)) return json(res, 200, { ok: false, reason: `у «${acc.title}» нет сессии` });
      if (running.get(acc.id)) return json(res, 200, { ok: false, reason: `«${acc.title}» занят: ${running.get(acc.id).title}` });
      if (!String(seeds || '').trim()) return json(res, 200, { ok: false, reason: 'укажи 1–3 канала-семени' });
      if (!String(niche || '').trim()) return json(res, 200, { ok: false, reason: 'укажи нишу' });
      const args = [path.join(CODE, 'discover-chats.py'),
        '--account', acc.id, '--seeds', String(seeds), '--niche', String(niche),
        '--levels', '2', '--min-subs', String(Number(minSubs) || 500),
        '--score', String(Number(score) || 0.5), '--limit', String(Number(limit) || 200)];
      if (dry) args.push('--dry');
      run(acc.id, 'disc', `Сбор чатов (${acc.title})`, pythonCmd(), args);
      return json(res, 200, { ok: true });
    }

    if (u.pathname === '/api/warmup') {
      if (req.method !== 'POST') return json(res, 200, warmView());
      const { on, rotate, rotateWait, days, between } = await body(req);
      if (typeof between === 'boolean' && between !== warmup.between) {
        warmup.between = between;
        push(between
          ? '\n🌱 «живой день» включён: аккаунты весь день читают каналы, ставят реакции и пишут своим'
          : '\n🌱 «живой день» выключен: прогрев в обычном ритме');
        warmSave();
      }
      if (days !== undefined) {
        const was = getWarmDays();
        setWarmDays(days);
        if (getWarmDays() !== was) {
          push(`\n🌱 срок прогрева: ${getWarmDays()} дн. (было ${was})`);
          // срок у аккаунтов считается от их warmFrom, поэтому новая лестница
          // применяется ко всем сразу — и к тем, кто уже греется
          warmSave();
        }
      }
      if (rotate !== undefined) {
        const clean = String(rotate || '').trim();
        if (clean) {
          const bad = rotateUrlProblem(clean);
          if (bad) return json(res, 200, { ok: false, reason: bad });
        }
        warmup.rotate = clean;
        warmup.rotateWait = num(rotateWait, warmup.rotateWait, 3, 600);
      }
      if (on === false) warmStop('вручную');
      else if (on === true) warmStart();
      else warmSave();
      return json(res, 200, { ok: true, ...warmView() });
    }

    // состав работающего режима — галочками на вкладке, без остановки
    if (u.pathname === '/api/auto/crew' && req.method === 'POST') {
      const { set, ids } = await body(req);
      if (!SETS.includes(set)) return json(res, 200, { ok: false, reason: 'нет такого режима' });
      return json(res, 200, setCrew(set, Array.isArray(ids) ? ids : []));
    }

    if (u.pathname === '/api/auto' && req.method === 'POST') {
      const o = await body(req);
      // «Остановить» с вкладки гасит ЕЁ режим, второй продолжает работать
      if (o.on === false) {
        if (SETS.includes(o.set) && auto.live[o.set]) stopSet(o.set, 'остановлено вручную');
        else autoStop('остановлено вручную');
        return json(res, 200, { ok: true });
      }
      return json(res, 200, autoStart(o));
    }
    /* ───────── РУЧНОЙ ЗАПУСК И ОСТАНОВКА ЗАДАЧ ───────── */


    if (u.pathname === '/api/start' && req.method === 'POST') {
      const { name, account, accounts: many, limit, delay, delayMax, hold, holdMax,
              send, voice, warm: w, chat, folder, again, onlyUser, join, phone, list, days,
              all, set } = await body(req);
      // set — по какой вкладке запускают ручной заход. Раньше его не присылали
      // и не принимали, и ручная рассылка шла по глобальному baseSet, даже если
      // человек стоял на вкладке чатов. Неизвестный/пустой набор — как раньше.
      const opts = { limit, delay, delayMax, hold, holdMax, send, voice, warm: w,
                     chat, folder, again, onlyUser, join, phone, list, days,
                     ...(SETS.includes(set) ? { set } : {}) };
      // разбор папки или списка — всеми свободными аккаунтами сразу (startParseAll)
      if (name === 'parse' && all && (folder || list)) return json(res, 200, startParseAll(opts));
      // список аккаунтов -> запускаем задачу на каждом СРАЗУ: они делят базу
      // бронями и идут параллельно. Одиночный account — как раньше.
      if (Array.isArray(many) && many.length) return json(res, 200, startMany(name, many, opts));
      return json(res, 200, start(name, { account, ...opts }));
    }

    if (u.pathname === '/api/loadbase' && req.method === 'POST') {
      const { path: p } = await body(req);
      if (!p) return json(res, 200, { ok: false, reason: 'укажи путь к файлу' });
      return json(res, 200, loadBase(p));
    }

    if (u.pathname === '/api/stop' && req.method === 'POST') {
      const { account } = await body(req);
      // «Остановить» без уточнения — значит всё: не выключив автопрогон,
      // мы бы убили процессы, а он через секунду запустил бы их снова
      if (!account) { autoStop('остановлено вручную'); enrich.stop('остановлено вручную'); }
      else if (auto.on && auto.per.has(account)) {
        auto.per.get(account).stopped = true;
        auto.per.get(account).note = 'снят вручную';
      }
      const keys = account ? [account] : [...running.keys()];
      for (const k of keys) {
        const r = running.get(k);
        if (r) { r.child.kill('SIGTERM'); push(`⏹ остановлено вручную: ${r.title}`); }
      }
      return json(res, 200, { ok: true });
    }

    res.writeHead(404).end('not found');
  } catch (e) {
    json(res, 500, { error: e.message.split('\n')[0] });
  }
}

// ---------- запуск ----------
if (!auth.configured()) {
  console.log('\n  Панель без пароля не поднимается.');
  console.log('  Задай вход:  node set-password.mjs <логин> <пароль>\n');
  process.exit(1);
}

// пароль по открытому HTTP на внешнем адресе уходит по сети как есть —
// пускаем только с сертификатом либо с явного согласия
if (!LOCAL && !TLS && !process.argv.includes('--insecure-http')) {
  console.log(`\n  Отказ: ${HOST} — не локальный адрес, а шифрования нет.`);
  console.log('  По открытому HTTP пароль от панели уйдёт по сети в чистом виде.\n');
  console.log('  Как правильно:');
  console.log('   • оставить панель на 127.0.0.1 и прокинуть её туннелем');
  console.log('     (cloudflared / ngrok) — шифрование и адрес получишь готовыми;');
  console.log('   • либо свой сертификат:  node admin.mjs --host 0.0.0.0 --cert cert.pem --key key.pem\n');
  console.log('  Если снаружи уже стоит nginx с HTTPS и панель слушает только его:');
  console.log('     node admin.mjs --host 0.0.0.0 --insecure-http\n');
  process.exit(1);
}

const server = TLS
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler)
  : http.createServer(handler);

server.on('error', (e) => {
  console.log(e.code === 'EADDRINUSE'
    ? `\n  Порт ${PORT} занят — панель уже запущена.\n` +
      `  Остановить старую:  lsof -ti tcp:${PORT} | xargs kill\n`
    : `ошибка сервера: ${e.message}`);
  process.exit(1);
});

// прогрев переживает перезапуск панели: был включён — включится снова
/* ------------------------------------------------------ зеркала-субдомены
 *
 * Одна и та же ссылка в тысяче писем — примета рассылки. Поэтому {LINK}
 * в тексте панель заменяет на живой субдомен boldo-agency.ru и меняет его
 * каждые 30–50 писем. Всё это ведёт сюда; текст собирает Python, читая
 * текущий адрес из mirror.json.
 */
const MIRROR_FILE = path.join(DIR, 'mirror.json');

const mirror = {
  on: false,
  mode: 'wildcard',          // wildcard | api
  base: 'boldo-agency.ru',
  every: [30, 50],           // сменить адрес через столько писем
  current: '', url: '',
  sinceCount: 0,             // сколько было написано на момент последней смены
  next: 0,                   // порог следующей смены (случайный из every)
  pool: [],                  // [{name, created, retired}]
  token: '', projectId: '', teamId: '',
  timer: null,
};

function mirrorSave() {
  try { fs.writeFileSync(MIRROR_FILE, JSON.stringify(mirror, (k, v) =>
    (k === 'timer' ? undefined : v), 2)); } catch {}
}
function mirrorLoad() {
  try { Object.assign(mirror, JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8')), { timer: null }); }
  catch {}
  if (mirror.on) mirrorStart();
}

/** Сколько писем написано всего — по нему считаем, пора ли менять адрес. */
const writtenCount = () => readAll('drafts.csv')
  .filter((r) => r.ok === 'true' || r.sent === 'true').length;

const secret = () => ({ token: mirror.token, projectId: mirror.projectId, teamId: mirror.teamId });

/**
 * Имена, на которые уже выпущен сертификат (mirror-names.txt, по одному на
 * строку). Wildcard-сертификат требует доступа к DNS, а сертификат на сотню
 * конкретных имён выпускается обычной HTTP-проверкой — поэтому в wildcard-
 * режиме берём имена только отсюда: придуманное на лету имя открылось бы у
 * человека с ошибкой «подключение не защищено».
 */
const MIRROR_NAMES = path.join(DIR, 'mirror-names.txt');
function certifiedName(used) {
  let names = [];
  try { names = fs.readFileSync(MIRROR_NAMES, 'utf8').split(/\s+/).filter(Boolean); } catch {}
  if (!names.length) return '';
  const fresh = names.filter((n) => !used.has(n));
  if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
  // все имена уже были — берём то, что светилось давнее всех
  const last = new Map(mirror.pool.map((m) => [m.name, m.created]));
  return names.sort((a, b) => String(last.get(a)).localeCompare(String(last.get(b))))[0];
}

/** Завести новый субдомен и сделать его текущим. */
async function mirrorRotate() {
  // имя, которого ещё не было в пуле
  let name;
  const used = new Set(mirror.pool.map((m) => m.name));
  if (mirror.mode === 'wildcard') name = certifiedName(used);
  if (!name) {
    for (let i = 0; i < 20; i++) { name = vercel.randomName(); if (!used.has(name)) break; }
  }
  const fqdn = `${name}.${mirror.base}`;

  if (mirror.mode === 'api') {
    if (!mirror.token || !mirror.projectId) {
      push('🪞 зеркала в режиме API, но не задан токен/проект Vercel — смена отменена');
      return false;
    }
    const r = await vercel.registerDomain(secret(), fqdn);
    if (!r.ok) { push(`🪞 не завёлся субдомен ${fqdn}: ${r.reason}`); return false; }
    // дать Vercel довыпустить сертификат: 200 не значит «готов сейчас же»
    if (!r.verified) {
      for (let i = 0; i < 6; i++) {
        await new Promise((z) => setTimeout(z, 5000));
        if (await vercel.domainReady(secret(), fqdn)) break;
      }
    }
  }

  mirror.pool.push({ name, created: new Date().toISOString(), retired: false });
  mirror.current = fqdn;
  mirror.url = `https://${fqdn}`;
  mirror.sinceCount = writtenCount();
  mirror.next = rnd(mirror.every[0], mirror.every[1]);
  mirrorSave();
  push(`🪞 новый адрес для ссылок: ${mirror.url}`);
  return true;
}

/** Раз в полминуты: не пора ли сменить адрес. */
function mirrorTick() {
  if (!mirror.on) return;
  if (!mirror.current) { mirrorRotate(); return; }
  if (writtenCount() - mirror.sinceCount >= mirror.next) mirrorRotate();
}

function mirrorStart() {
  if (mirror.timer) return;
  mirror.on = true;
  mirror.timer = setInterval(mirrorTick, 30000);
  mirrorTick();
  mirrorSave();
}
function mirrorStop() {
  if (mirror.timer) clearInterval(mirror.timer);
  mirror.timer = null;
  mirror.on = false;
  mirrorSave();
}

/** Убрать субдомены старше 7 суток (только режим api — в wildcard чистить нечего). */
async function mirrorCleanup() {
  if (!mirror.on || mirror.mode !== 'api' || !mirror.token) return 0;
  const week = Date.now() - 7 * 864e5;
  const old = mirror.pool.filter((m) => !m.retired && Date.parse(m.created) < week
    && `${m.name}.${mirror.base}` !== mirror.current);
  let gone = 0;
  for (const m of old) {
    const r = await vercel.deleteDomain(secret(), `${m.name}.${mirror.base}`);
    if (r.ok) { m.retired = true; gone++; }
  }
  if (gone) { push(`🪞 убрано старых субдоменов: ${gone}`); mirrorSave(); }
  return gone;
}
setInterval(mirrorCleanup, 24 * 3600 * 1000);   // раз в сутки заглядываем

/** Что показать в панели (без токена — он наружу не уходит). */
function mirrorView() {
  return {
    on: mirror.on, mode: mirror.mode, base: mirror.base, every: mirror.every,
    url: mirror.url, current: mirror.current,
    sent: writtenCount(), sinceCount: mirror.sinceCount, next: mirror.next,
    pool: mirror.pool.filter((m) => !m.retired).length,
    hasToken: !!mirror.token, projectId: mirror.projectId ? 'задан' : '',
  };
}

warmLoad();
mirrorLoad();
// даём панели подняться и дочитать свои файлы, потом продолжаем прогон
setTimeout(autoResume, 5000);

server.listen(PORT, HOST, () => {
  proxyGuard.start();
  const url = `${TLS ? 'https' : 'http'}://${LOCAL ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  ПУЛЬТ: ${url}   (вход по логину и паролю)\n`);
  const moved = accounts.migrateDraftsLog();
  push(moved ? `панель запущена; история черновиков (${moved} строк) переведена на новый формат`
             : 'панель запущена, готов к работе');
  if (LOCAL && !process.argv.includes('--no-open')) {
    exec(process.platform === 'darwin' ? `open ${url}`
       : process.platform === 'win32' ? `start ${url}` : `xdg-open ${url}`);
  }
});
