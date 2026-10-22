/**
 * Обогащение: панель водит читателей по очереди чатов и зовёт разбор.
 *
 * Сама работа — в Python (enrich-find / enrich-read / enrich-analyze, общий
 * enrich.py). Здесь только диспетчер, как и везде в панели:
 *
 *   • «Найти чаты» — ключевики по теме (модель), потом поиск по ним
 *     аккаунтом-читателем, порциями, пока ключевики не кончатся;
 *   • «Собрать лидов» — каждый свободный читатель берёт по чату (один чат —
 *     один читатель, бронь в enrich/chats.json), разбор идёт следом, по одному
 *     чату за раз. В работе одновременно не больше «читатели + 1» чатов —
 *     чтобы не выкачать сразу сотню чатов, которые модель разберёт через неделю.
 *
 * Очередь чатов панель только ЧИТАЕТ, а пишет через `python enrich.py …`:
 * замок на файл живёт в Python, и запись панели не затрёт запись читателя.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TICK = 15_000;
const IN_WORK = ['reading', 'downloaded', 'analyzing'];

export function makeEnrich({ DIR, CODE, accounts, running, launch, pythonCmd, push, note,
                             busy, proxyDown, readRaw, resting = () => false, slots = () => Infinity,
                             readerCap = Infinity }) {
  const ROOT = path.join(DIR, 'enrich');
  const STATE = path.join(ROOT, 'state.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) ?? d; } catch { return d; } };

  // вкл/выкл и цель переживают перезапуск панели
  const st = { on: false, finding: false, goal: '', topic: '', ...read(STATE, {}) };
  // панель перезапустилась, пока модель разбирала запрос автопилота: план умер
  // вместе с ней — не делаем вид, что автопилот работает
  if (st.planning || (st.auto && !st.on && !st.finding)) {
    st.auto = false;
    delete st.planning;
    st.planErr = 'панель перезапускалась, пока модель разбирала запрос — запусти автопилот снова';
  }
  const save = () => {
    fs.mkdirSync(ROOT, { recursive: true });
    const tmp = `${STATE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n');
    fs.renameSync(tmp, STATE);
  };

  const per = new Map();          // id читателя -> { nextAt, note }
  let analyzer = null;            // { child, key, title, since }
  let analyzeHold = 0;            // модель не отвечала — разбор ждёт до этого времени
  let kwJob = null;               // идёт подбор ключевиков моделью
  let releasing = false;          // панель возвращает в очередь чаты упавших читателей
  let findHold = 0;               // заходы «только похожие» — не чаще раза в 5 минут
  let planJob = null;             // автопилот: модель разбирает запрос владельца
  let planChild = null;           // её процесс — «Остановить» его гасит
  const busyWith = (re) => [...running.values()].some((r) => re.test(r.title || ''));
  /** Лиды, чей профиль ещё не смотрели (то же правило, что enrich.profile_todo). */
  const profileLeft = () => leads().list.filter((l) => !l.profile_at && !l.excluded
    && (Number(l.profile_tries) || 0) < 2).length;

  const chats = () => read(path.join(ROOT, 'chats.json'), {});
  const keywords = () => read(path.join(ROOT, 'keywords.json'), {});
  const kwLeft = () => (keywords().items || []).filter((i) => !i.done).length;
  // каналы, у которых ещё не спрашивали «похожие» (то же правило, что enrich.similar_seeds)
  const SIMILAR_LEVELS = 2;
  const simLeft = () => Object.values(chats()).filter((v) => v.kind === 'channel' && !v.similar
    && v.status !== 'error' && (Number(v.level) || 0) < SIMILAR_LEVELS && v.ref).length;
  const findLeft = () => kwLeft() + simLeft();

  /** Лиды по ключу получателя (@ник и id:<id>) — тот же расклад, что в enrich.lead_refs. */
  let leadsCache = { mtime: -1, list: [], keys: new Set(), excluded: new Set() };
  function leads() {
    // свой файл в enrich/: в корне бывает leads.json убранного поиска горячих
    // лидов — те же id, другая форма записей
    const f = path.join(ROOT, 'leads.json');
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch { return leadsCache = { mtime: 0, list: [], keys: new Set(), excluded: new Set() }; }
    if (mtime !== leadsCache.mtime) {
      const list = Object.values(read(f, {}));
      const keys = new Set();
      const excluded = new Set();                   // по профилю — продавец: писать не будем
      for (const l of list) {
        const to = l.excluded ? excluded : keys;
        if (l.key) to.add(l.key);                   // под этим ключом лид лежит в очереди
        if (l.username) to.add('@' + String(l.username).replace(/^@/, ''));
        if (l.uid) to.add(`id:${l.uid}`);
      }
      leadsCache = { mtime, list, keys, excluded };
    }
    return leadsCache;
  }
  const leadKeys = () => leads().keys;
  const excludedKeys = () => leads().excluded;

  /**
   * Лиды, которых сегодня отложили ВСЕ эти писатели (вступления кончились —
   * enrich/later.json, его ведёт draft-messages.put_off). Для прогона это не
   * работа до завтра: иначе он звал бы писателя к ним каждую минуту.
   */
  function putOffAll(ids) {
    if (!ids.length) return new Set();
    const day = new Date().toISOString().slice(0, 10);
    const data = read(path.join(ROOT, 'later.json'), {});
    let out = null;
    for (const id of ids) {
      const got = data[id]?.day === day ? new Set(data[id].keys || []) : new Set();
      out = out ? new Set([...out].filter((k) => got.has(k))) : got;
    }
    return out || new Set();
  }
  /** Все лиды, отложенные сегодня хоть кем-то, — короткий список для подсчётов прогона. */
  function putOffAny() {
    const day = new Date().toISOString().slice(0, 10);
    const out = new Set();
    for (const v of Object.values(read(path.join(ROOT, 'later.json'), {}))) {
      if (v?.day === day) for (const k of v.keys || []) out.add(k);
    }
    return out;
  }
  const keyOf = (l) => l.key || (l.username ? '@' + String(l.username).replace(/^@/, '') : `id:${l.uid}`);

  /** Python-помощник (enrich.py, enrich-find.py) без аккаунта: вернёт последнюю JSON-строку. */
  function py(args, onLine) {
    let child = null;
    const job = new Promise((done) => {
      const c = child = spawn(pythonCmd(), args.map((a, i) => (i === 0 ? path.join(CODE, a) : a)), { cwd: DIR });
      let out = '';
      const feed = (b) => {
        out += b;
        if (onLine) String(b).split('\n').filter(Boolean).forEach(onLine);
      };
      c.stdout.on('data', feed);
      c.stderr.on('data', feed);
      c.on('close', (code) => {
        const last = out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
        let res = null;
        try { res = last ? JSON.parse(last) : null; } catch {}
        done({ code, res, out });
      });
    });
    job.child = child;
    return job;
  }

  /** Кто может читать прямо сейчас: роль «читатель», вошёл, свободен, прокси жив. */
  function readers() {
    return accounts.list().filter((a) => a.role === 'read' && !a.reserve && !a.retired
      && accounts.hasSession(a) && accounts.isAuthed(a)
      && !accounts.fullRestLeft(a) && a.spamKind !== 'frozen' && a.spamKind !== 'perm'
      // первые сутки свежий аккаунт не трогаем вовсе — как и в остальной панели
      && !resting(a));
  }
  function freeReaders() {
    const now = Date.now();
    const busyProxy = new Set([...running.keys()].map((id) =>
      accounts.list().find((a) => a.id === id)?.proxy || 'direct'));
    const out = [];
    // общий потолок задач панели (TG_MAX_PARALLEL), а читателям — не больше его
    // половины: рассылке и прогреву места должно хватать всегда
    const reading = [...running.values()].filter((r) => /^(Чтение чата|Поиск чатов|Профили лидов)/.test(r.title || '')).length;
    let room = Math.min(slots(), readerCap - reading);
    for (const a of readers()) {
      if (room <= 0) break;
      if (running.has(a.id) || busy(a.id) || proxyDown(a.proxy)) continue;
      if ((per.get(a.id)?.nextAt || 0) > now) continue;
      // один аккаунт на адрес за раз — как в разборе чатов (parseCrew)
      const k = a.proxy || 'direct';
      if (busyProxy.has(k)) continue;
      busyProxy.add(k);
      out.push(a);
      room--;
    }
    return out;
  }

  /** Читатель отработал: когда звать снова — по его отчёту (флуд, предел вступлений). */
  function after(id, what) {
    return (code, s) => {
      const p = per.get(id) || {};
      const cool = Number(s?.cooldown) || 0;
      if (cool) {
        p.nextAt = Date.now() + cool * 1000;
        p.note = s?.note || (s?.stop === 'flood' ? 'флуд-пауза' : 'отдых');
      } else if (code !== 0 && !s) {
        p.nextAt = Date.now() + 5 * 60_000;
        p.note = `${what}: сбой, повтор через 5 мин`;
      } else {
        p.nextAt = Date.now() + (20 + Math.random() * 40) * 1000;
        p.note = '';
      }
      per.set(id, p);
    };
  }

  function startAnalyze() {
    const all = chats();
    const pick = ['analyzing', 'downloaded'].map((s) => Object.entries(all).find(([, v]) => v.status === s))
      .find(Boolean);
    if (!pick) return;
    const [key, ch] = pick;
    const c = spawn(pythonCmd(), [path.join(CODE, 'enrich-analyze.py'), '--chat', key], { cwd: DIR });
    analyzer = { child: c, key, title: ch.title || ch.ref, since: Date.now() };
    push(`\n▶ Разбор лидов: ${analyzer.title}`);
    let state = null;
    const feed = (b) => String(b).split('\n').filter(Boolean).forEach((l) => {
      if (l.startsWith('⌁STATE')) { try { state = JSON.parse(l.slice(6)); } catch {} return; }
      push(`[лиды] ${l}`);
    });
    c.stdout.on('data', feed);
    c.stderr.on('data', feed);
    c.on('close', (code) => {
      push(`■ Разбор лидов — ${analyzer?.title} завершён (код ${code})`);
      const done = chats()[key];
      if (done?.status === 'done') note('🎯', `чат «${analyzer?.title}» разобран: лидов ${done.leads || 0} из ${done.authors || 0} авторов`);
      if (state?.cooldown) analyzeHold = Date.now() + state.cooldown * 1000;
      else if (code !== 0) analyzeHold = Date.now() + 5 * 60_000;
      analyzer = null;
    });
  }

  function tick() {
    if (!st.on && !st.finding) return;
    const now = Date.now();
    const all = Object.values(chats());
    const count = (s) => all.filter((v) => v.status === s).length;

    // разбор: по одному чату за раз, без аккаунта
    if (st.on && !analyzer && now >= analyzeHold && (count('downloaded') + count('analyzing'))) startAnalyze();

    let free = freeReaders();
    // поиск чатов: одним читателем, порциями, пока есть непройденные ключевики
    if (st.finding) {
      if (!findLeft()) {
        st.finding = false; save();
        note('🔎', 'поиск чатов закончен: ключевики пройдены, похожие каналы проверены');
      } else if (now >= findHold && ![...running.values()].some((r) => /Поиск чатов/.test(r.title)) && free.length) {
        const a = free.shift();
        launch('enrichFind', { account: a.id }, (code, s) => {
          after(a.id, 'поиск')(code, s);
          // шли только «похожие» — следующий заход через 5 минут; читатель свободен
          if (s?.note === 'похожие') findHold = Date.now() + 5 * 60_000;
        });
      }
    }

    // чтение: не больше «читатели + 1» чатов в работе — остальные ждут разбора.
    // «Читается» без живого процесса читателя не в счёт: упавший заход не
    // должен держать место (сам чат вернётся в очередь при следующем заходе)
    if (!st.on) return;
    let fresh = count('new');

    // профили лидов (описание, личный канал): одним читателем, порциями. Если
    // свободный читатель один и чаты ждут чтения — сначала чтение
    if (profileLeft() && !busyWith(/^Профили лидов/) && free.length && (free.length > 1 || !fresh)) {
      // лучше тот, кто читал их чаты: людей оттуда он уже знает, а лида из
      // закрытого чата без @ника видит только он
      const readOf = new Map();             // chat_id -> все, кто его читал (дубли по второй ссылке — мимо)
      for (const v of all) {
        if (!v.chat_id || v.status === 'skipped') continue;
        const k = String(v.chat_id);
        readOf.set(k, [...(readOf.get(k) || []), ...(v.read_by || []), v.reader].filter(Boolean));
      }
      const owners = new Set(leads().list.filter((l) => !l.profile_at && !l.excluded
        && (Number(l.profile_tries) || 0) < 2).flatMap((l) => (l.chats || []).flatMap((c) => readOf.get(String(c.chat_id)) || [])));
      const i = free.findIndex((x) => owners.has(x.id));
      const [a] = free.splice(i >= 0 ? i : 0, 1);
      // кого панель готова запускать: лидов вышедших из строя читателей пробует любой
      launch('enrichProfile', { account: a.id, alive: readers().map((x) => x.id) }, after(a.id, 'профили'));
    }
    const live = (v) => (v.status === 'reading' ? running.has(v.reader) : IN_WORK.includes(v.status));
    let inWork = all.filter(live).length;
    const orphans = Object.entries(chats()).filter(([, v]) => v.status === 'reading' && !running.has(v.reader));
    if (orphans.length && !releasing) {
      releasing = true;
      py(['enrich.py', 'release', ...orphans.flatMap(([k, v]) => [k, v.reader || ''])])
        .finally(() => { releasing = false; });
    }
    const cap = readers().length + 1;
    for (const a of free) {
      if (!fresh || inWork >= cap) break;
      const r = launch('enrichRead', { account: a.id }, after(a.id, 'чтение'));
      if (r.ok) { fresh--; inWork++; }
    }
    // очередь пуста и всё разобрано — выключаемся сами, чтобы не крутиться вхолостую.
    // inWork — уже после раздачи этого захода: последний чат только что ушёл читателю
    if (!fresh && !inWork && !orphans.length && !st.finding && !analyzer && !planJob
        && !profileLeft() && !busyWith(/^Профили лидов/)) {
      const wasAuto = st.auto;
      st.on = false; st.auto = false; save();
      const n = leads().list.filter((l) => !l.excluded).length;
      note('✅', wasAuto ? `автопилот закончил: лидов ${n} — чаты разобраны, профили посмотрены`
                          : 'сбор лидов: все чаты из очереди разобраны');
    }
  }
  setInterval(tick, TICK);
  setTimeout(tick, 10_000);

  /* ───────── что показывает вкладка «Лиды» ───────── */

  function leadStatus() {
    // написали ли лиду — по журналу рассылки «по чатам», как и у всех остальных
    const st2 = new Map();
    for (const r of readRaw(path.join('chats', 'drafts.csv'))) {
      const was = st2.get(r.phone);
      if (r.sent === 'true') st2.set(r.phone, 'написали');
      else if (r.ok === 'true' && was !== 'написали') st2.set(r.phone, 'черновик');
      else if (!was) st2.set(r.phone, r.ok === 'skip' ? 'давно не заходил' : 'не вышло');
    }
    return st2;
  }

  function view() {
    const all = chats();
    const list = Object.entries(all).map(([key, v]) => ({ key, ...v }));
    const order = { reading: 0, analyzing: 1, downloaded: 2, new: 3, error: 4, skipped: 5, done: 6 };
    list.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)
      || String(b.done_at || b.added || '').localeCompare(String(a.done_at || a.added || '')));
    const counts = {};
    for (const v of list) counts[v.status] = (counts[v.status] || 0) + 1;
    const kw = keywords();
    const ls = leadStatus();
    const L = leads().list.map((l) => ({
      key: keyOf(l), uid: l.uid, username: l.username || '', name: l.name || '',
      chats: (l.chats || []).map((c) => c.title).filter(Boolean),
      why: (l.chats || []).slice(-1)[0]?.why || '', note: l.note || '',
      score: Number(l.score) || 0, facts: l.facts || {},
      profile: l.profile_at ? { about: l.profile?.about || '', channel: l.profile?.channel || null } : null,
      excluded: l.excluded || '',
      found: l.found_at || '', status: l.excluded ? 'исключён' : (ls.get(keyOf(l)) || 'в очереди'),
    })).sort((a, b) => (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) || b.score - a.score
      || String(b.found).localeCompare(String(a.found)));
    const now = Date.now();
    const ready = new Set(readers().map((a) => a.id));     // один раз: отлёжка считается по журналу
    return {
      on: st.on, finding: st.finding, goal: st.goal, topic: st.topic || kw.topic || '',
      auto: !!st.auto && (st.on || st.finding || !!planJob), query: st.query || '', planning: !!planJob,
      planErr: st.planErr || '', planOk: !!st.goal && st.planFor === st.query,
      profileLeft: profileLeft(), profileBusy: busyWith(/^Профили лидов/),
      kwBusy: !!kwJob,
      keywords: { total: (kw.items || []).length, left: kwLeft(), list: (kw.items || []).map((i) => i.q) },
      similarLeft: simLeft(),
      analyzer: analyzer ? { title: analyzer.title, since: analyzer.since } : null,
      counts, chats: list.slice(0, 500), chatsTotal: list.length,
      readers: accounts.list().filter((a) => a.role === 'read').map((a) => {
        const p = per.get(a.id) || {};
        return { id: a.id, name: a.name || a.title, title: a.title,
                 busy: running.get(a.id)?.title || '',
                 ready: ready.has(a.id), resting: !ready.has(a.id) && !!resting(a),
                 rest: p.nextAt > now ? Math.round((p.nextAt - now) / 60_000) : 0, note: p.note || '' };
      }),
      leads: L.slice(0, 500), leadsTotal: L.filter((l) => !l.excluded).length,
      leadsExcluded: L.filter((l) => l.excluded).length,
      leadsLeft: L.filter((l) => l.status === 'в очереди' || l.status === 'не вышло').length,
    };
  }

  function leadsCsv() {
    // Excel считает формулой и поле в кавычках, если оно начинается с = + - @:
    // а «о себе» и название канала пишет сам человек
    const q = (s) => {
      const v = String(s ?? '');
      return `"${(/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""')}"`;
    };
    const rows = [['ключ', 'username', 'id', 'имя', 'уверенность', 'факты', 'о себе', 'личный канал', 'чаты',
      'почему', 'заметка', 'статус', 'исключён', 'найден']];
    const ls = leadStatus();
    for (const l of leads().list) {
      const facts = Object.entries(l.facts || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
      const chan = l.profile?.channel ? `${l.profile.channel.title} @${l.profile.channel.username || ''}` : '';
      rows.push([keyOf(l), l.username || '', l.uid, l.name || '', l.score || '', facts, l.profile?.about || '', chan,
        (l.chats || []).map((c) => c.title).join('; '), (l.chats || []).slice(-1)[0]?.why || '', l.note || '',
        ls.get(keyOf(l)) || 'в очереди', l.excluded || '', l.found_at || '']);
    }
    return '﻿' + rows.map((r) => r.map(q).join(';')).join('\n') + '\n';
  }

  /* ───────── действия кнопок ───────── */

  /** Модель ещё думает над запросом автопилота — гасим, иначе она перепишет
   *  ключевики отменённого запроса, а кнопка провисит до её ответа. */
  function cancelPlan() {
    if (!planJob) return;
    if (planChild) { try { planChild.kill('SIGTERM'); } catch {} }
    delete st.planning;
    st.planErr = 'автопилот остановлен, пока модель разбирала запрос';
  }

  /** Остановить всё обогащение: общая кнопка «Остановить», полная чистка. */
  function stop(why) {
    const was = st.on || st.finding || st.auto || !!planJob;
    cancelPlan();
    st.on = false; st.finding = false; st.auto = false; save();
    if (analyzer) { try { analyzer.child.kill('SIGTERM'); } catch {} }
    if (was) note('⏸', `сбор лидов и поиск чатов остановлены${why ? ' — ' + why : ''}`);
  }

  const NO_READERS = 'нет готовых читателей: отметь их в шаге 1 на этой вкладке ' +
    '(вошедшие аккаунты, свежим нужны сутки отлёжки)';

  /**
   * Автопилот: владелец пишет одну фразу («хочет квартиру в Екб») — модель
   * разворачивает её в цель разбора, тему и сотни ключевиков (enrich-find
   * --plan), дальше само: поиск чатов и похожих, чтение, разбор, профили.
   * Кончается на готовых лидах; писать им — отдельной кнопкой.
   *
   * queue — что делать с чатами прошлого запроса, до которых не дошли:
   * 'clear' — в «пропущен» (на новый запрос не тратим вступления и разбор),
   * 'keep' — оставить. Не сказано, а такие есть — спросим владельца.
   */
  function autopilot(query, queue) {
    query = String(query || '').trim().slice(0, 300);
    if (!query) return { ok: false, reason: 'напиши, кого ищем: например «хочет купить квартиру в Екатеринбурге»' };
    if (planJob) return { ok: false, reason: 'автопилот уже разбирает запрос — подожди минуту' };
    if (kwJob) return { ok: false, reason: 'ключевики ещё подбираются — подожди минуту' };
    if (!readers().length) {
      return { ok: false, reason: 'среди отмеченных нет готовых аккаунтов: нужны вошедшие, свежим — сутки отлёжки' };
    }
    const left = Object.values(chats()).filter((v) => v.status === 'new').length;
    // прошлый запрос — тот, чей план приняли (остановленный на полпути не в счёт)
    const prev = st.planFor || st.goal || '';
    if (left && prev && prev !== query && !['clear', 'keep'].includes(queue)) {
      return { ok: false, ask: 'queue', n: left, prev };
    }
    st.query = query; st.auto = true; st.finding = false; st.planErr = ''; st.planning = query; save();
    push(`\n▶ Автопилот: «${query}»`);
    const job = py(['enrich-find.py', '--plan', '--query', query], (l) => {
      if (!l.startsWith('\u2301STATE') && !l.startsWith('{')) push(`[автопилот] ${l}`);
    });
    planChild = job.child;
    planJob = job.then(async ({ code, res, out }) => {
      delete st.planning;
      if (!st.auto) { planJob = planChild = null; save(); return; }   // пока модель думала, автопилот остановили
      if (code !== 0 || !res?.ok) {
        planJob = planChild = null;
        const why = String(out || '').trim().split('\n').filter((l) => !l.startsWith('\u2301')).pop() || '';
        st.auto = false; st.planErr = `модель не разобрала запрос${why ? ': ' + why.slice(0, 160) : ''}`; save();
        note('⚠', 'автопилот: модель не разобрала запрос — смотри журнал, попробуй ещё раз');
        return;
      }
      if (queue === 'clear' && left) {
        const r = await py(['enrich.py', 'skip-new', `прошлый запрос: ${prev}`.slice(0, 200)]);
        if (r.res?.n) note('🧹', `чаты прошлого запроса отложены: ${r.res.n} (вернуть — «перечитать»)`);
      }
      planJob = planChild = null;
      if (!st.auto) return;
      st.goal = res.goal; st.topic = res.topic; st.planFor = query; st.on = true; st.finding = true; save();
      note('🤖', `автопилот: ищу тех, кто ${res.goal} · ключевиков ${res.n}`);
      setTimeout(tick, 500);
    });
    return { ok: true };
  }

  function setOn(on) {
    if (on && !readers().length) return { ok: false, reason: NO_READERS };
    if (on && !Object.values(chats()).some((v) => ['new', ...IN_WORK].includes(v.status))) {
      return { ok: false, reason: 'очередь чатов пуста — добавь ссылки или найди чаты по ключевикам' };
    }
    st.on = !!on;
    if (!on) { cancelPlan(); st.auto = false; }   // остановили сбор руками — автопилот больше не ведёт
    save();
    note(on ? '🎯' : '⏸', on ? 'сбор лидов включён' : 'сбор лидов остановлен');
    if (on) setTimeout(tick, 500);
    return { ok: true, on: st.on };
  }

  function setGoal(goal) {
    st.goal = String(goal || '').trim().slice(0, 500);
    save();
    return { ok: true, goal: st.goal };
  }

  async function addChats(text) {
    const lines = String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return { ok: false, reason: 'вставь ссылки на чаты — по одной на строку' };
    fs.mkdirSync(ROOT, { recursive: true });
    const f = path.join(ROOT, 'add-list.txt');
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const { res } = await py(['enrich.py', 'add', f]);
    return res || { ok: false, reason: 'не вышло записать очередь' };
  }

  async function chatsCmd(cmd, keys) {
    if (!['retry', 'remove'].includes(cmd) || !Array.isArray(keys) || !keys.length) {
      return { ok: false, reason: 'не понял, что сделать' };
    }
    const { res } = await py(['enrich.py', cmd, ...keys.map(String)]);
    return res || { ok: false, reason: 'не вышло' };
  }

  function makeKeywords(topic) {
    topic = String(topic || '').trim();
    if (!topic) return { ok: false, reason: 'напиши тему, например «Квартиры в Екатеринбурге»' };
    if (kwJob) return { ok: false, reason: 'ключевики уже подбираются — подожди минуту' };
    if (planJob) return { ok: false, reason: 'автопилот разбирает запрос — подожди или останови его' };
    if (st.finding) return { ok: false, reason: 'идёт поиск по старым ключевикам — сначала останови его' };
    st.topic = topic; save();
    push(`\n▶ Ключевики по теме «${topic}»`);
    kwJob = py(['enrich-find.py', '--keywords', '--topic', topic], (l) => {
      if (!l.startsWith('⌁STATE')) push(`[ключевики] ${l}`);
    }).then(({ code }) => {
      kwJob = null;
      const n = (keywords().items || []).length;
      note(code === 0 ? '🔑' : '⚠', code === 0 ? `ключевики по теме «${topic}»: ${n}` : 'ключевики подобрать не вышло — смотри журнал');
    });
    return { ok: true };
  }

  function saveKeywords(list) {
    if (planJob) return { ok: false, reason: 'автопилот разбирает запрос — подожди или останови его' };
    if (st.finding) return { ok: false, reason: 'идёт поиск — сначала останови его' };
    const old = keywords();
    const done = new Map((old.items || []).map((i) => [i.q.toLowerCase(), i]));
    const seen = new Set();
    const items = [];
    for (const raw of String(list || '').split('\n')) {
      const q = raw.trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!q || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      items.push(done.get(q.toLowerCase()) || { q, done: false, found: 0 });
    }
    fs.mkdirSync(ROOT, { recursive: true });
    const f = path.join(ROOT, 'keywords.json');
    // своё имя временного файла: тот же файл в это время может писать enrich-find
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...old, topic: old.topic || st.topic, items }, null, 1) + '\n');
    fs.renameSync(tmp, f);
    return { ok: true, total: items.length, left: items.filter((i) => !i.done).length };
  }

  function find(on) {
    if (!on) { st.finding = false; save(); return { ok: true }; }
    if (!findLeft()) {
      return { ok: false, reason: 'искать нечего: подбери ключевики по теме или добавь каналы ссылками — ' +
        'у каналов поиск спросит похожие' };
    }
    if (kwJob) return { ok: false, reason: 'ключевики ещё подбираются — подожди' };
    if (planJob) return { ok: false, reason: 'автопилот разбирает запрос — подожди или останови его' };
    if ([...running.values()].some((r) => /^Поиск чатов/.test(r.title || ''))) {
      return { ok: false, reason: 'прошлый поиск ещё заканчивает ключевик — подожди минуту' };
    }
    if (!readers().length) return { ok: false, reason: NO_READERS };
    st.finding = true; save();
    note('🔎', `поиск чатов: ключевиков ${kwLeft()}, каналов для похожих ${simLeft()}`);
    setTimeout(tick, 500);
    return { ok: true };
  }

  // tick — наружу только для песочницы (tests/sandbox/enrich_sched_test.mjs)
  return { view, leadsCsv, leadKeys, excludedKeys, putOffAll, putOffAny, autopilot, setOn, setGoal, addChats, chatsCmd, makeKeywords, saveKeywords, find, tick, stop,
           status: () => ({ on: st.on, finding: st.finding }) };
}
