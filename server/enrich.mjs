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
                             busy, proxyDown, readRaw }) {
  const ROOT = path.join(DIR, 'enrich');
  const STATE = path.join(ROOT, 'state.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) ?? d; } catch { return d; } };

  // вкл/выкл и цель переживают перезапуск панели
  const st = { on: false, finding: false, goal: '', topic: '', ...read(STATE, {}) };
  const save = () => {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(STATE + '.tmp', JSON.stringify(st, null, 1) + '\n');
    fs.renameSync(STATE + '.tmp', STATE);
  };

  const per = new Map();          // id читателя -> { nextAt, note }
  let analyzer = null;            // { child, key, title, since }
  let analyzeHold = 0;            // модель не отвечала — разбор ждёт до этого времени
  let kwJob = null;               // идёт подбор ключевиков моделью

  const chats = () => read(path.join(ROOT, 'chats.json'), {});
  const keywords = () => read(path.join(ROOT, 'keywords.json'), {});
  const kwLeft = () => (keywords().items || []).filter((i) => !i.done).length;

  /** Лиды по ключу получателя (@ник и id:<id>) — тот же расклад, что в enrich.lead_refs. */
  let leadsCache = { mtime: -1, list: [], keys: new Set() };
  function leads() {
    const f = path.join(DIR, 'leads.json');
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch { return leadsCache = { mtime: 0, list: [], keys: new Set() }; }
    if (mtime !== leadsCache.mtime) {
      const list = Object.values(read(f, {}));
      const keys = new Set();
      for (const l of list) {
        if (l.username) keys.add('@' + String(l.username).replace(/^@/, ''));
        if (l.uid) keys.add(`id:${l.uid}`);
      }
      leadsCache = { mtime, list, keys };
    }
    return leadsCache;
  }
  const leadKeys = () => leads().keys;
  const keyOf = (l) => (l.username ? '@' + String(l.username).replace(/^@/, '') : `id:${l.uid}`);

  /** Python-помощник (enrich.py, enrich-find.py) без аккаунта: вернёт последнюю JSON-строку. */
  function py(args, onLine) {
    return new Promise((done) => {
      const c = spawn(pythonCmd(), args.map((a, i) => (i === 0 ? path.join(CODE, a) : a)), { cwd: DIR });
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
  }

  /** Кто может читать прямо сейчас: роль «читатель», вошёл, свободен, прокси жив. */
  function readers() {
    return accounts.list().filter((a) => a.role === 'read' && !a.reserve && !a.retired
      && accounts.hasSession(a) && accounts.isAuthed(a)
      && !accounts.fullRestLeft(a) && a.spamKind !== 'frozen' && a.spamKind !== 'perm');
  }
  function freeReaders() {
    const now = Date.now();
    const busyProxy = new Set([...running.keys()].map((id) =>
      accounts.list().find((a) => a.id === id)?.proxy || 'direct'));
    const out = [];
    for (const a of readers()) {
      if (running.has(a.id) || busy(a.id) || proxyDown(a.proxy)) continue;
      if ((per.get(a.id)?.nextAt || 0) > now) continue;
      // один аккаунт на адрес за раз — как в разборе чатов (parseCrew)
      const k = a.proxy || 'direct';
      if (busyProxy.has(k)) continue;
      busyProxy.add(k);
      out.push(a);
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
      if (!kwLeft()) {
        st.finding = false; save();
        note('🔎', 'поиск чатов по ключевикам закончен');
      } else if (![...running.values()].some((r) => /Поиск чатов/.test(r.title)) && free.length) {
        const a = free.shift();
        launch('enrichFind', { account: a.id }, after(a.id, 'поиск'));
      }
    }

    // чтение: не больше «читатели + 1» чатов в работе — остальные ждут разбора
    if (!st.on) return;
    let fresh = count('new');
    let inWork = all.filter((v) => IN_WORK.includes(v.status)).length;
    const cap = readers().length + 1;
    for (const a of free) {
      if (!fresh || inWork >= cap) break;
      const r = launch('enrichRead', { account: a.id }, after(a.id, 'чтение'));
      if (r.ok) { fresh--; inWork++; }
    }
    // очередь пуста и всё разобрано — выключаемся сами, чтобы не крутиться вхолостую
    if (!fresh && !all.some((v) => IN_WORK.includes(v.status)) && !st.finding && !analyzer) {
      st.on = false; save();
      note('✅', 'сбор лидов: все чаты из очереди разобраны');
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
      found: l.found_at || '', status: ls.get(keyOf(l)) || 'в очереди',
    })).sort((a, b) => String(b.found).localeCompare(String(a.found)));
    const now = Date.now();
    return {
      on: st.on, finding: st.finding, goal: st.goal, topic: st.topic || kw.topic || '',
      kwBusy: !!kwJob,
      keywords: { total: (kw.items || []).length, left: kwLeft(), list: (kw.items || []).map((i) => i.q) },
      analyzer: analyzer ? { title: analyzer.title, since: analyzer.since } : null,
      counts, chats: list.slice(0, 500), chatsTotal: list.length,
      readers: accounts.list().filter((a) => a.role === 'read').map((a) => {
        const p = per.get(a.id) || {};
        return { id: a.id, name: a.name || a.title, title: a.title,
                 busy: running.get(a.id)?.title || '',
                 ready: readers().some((x) => x.id === a.id),
                 rest: p.nextAt > now ? Math.round((p.nextAt - now) / 60_000) : 0, note: p.note || '' };
      }),
      leads: L.slice(0, 500), leadsTotal: L.length,
      leadsLeft: L.filter((l) => l.status === 'в очереди' || l.status === 'не вышло').length,
    };
  }

  function leadsCsv() {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['ключ', 'username', 'id', 'имя', 'чаты', 'почему', 'заметка', 'статус', 'найден']];
    const ls = leadStatus();
    for (const l of leads().list) {
      rows.push([keyOf(l), l.username || '', l.uid, l.name || '', (l.chats || []).map((c) => c.title).join('; '),
        (l.chats || []).slice(-1)[0]?.why || '', l.note || '', ls.get(keyOf(l)) || 'в очереди', l.found_at || '']);
    }
    return '﻿' + rows.map((r) => r.map(q).join(';')).join('\n') + '\n';
  }

  /* ───────── действия кнопок ───────── */

  function setOn(on) {
    if (on && !readers().length) {
      return { ok: false, reason: 'нет читателей: на вкладке «Аккаунты» переведи хотя бы один вошедший аккаунт в роль «читатель»' };
    }
    if (on && !Object.values(chats()).some((v) => ['new', ...IN_WORK].includes(v.status))) {
      return { ok: false, reason: 'очередь чатов пуста — добавь ссылки или найди чаты по ключевикам' };
    }
    st.on = !!on; save();
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
    fs.writeFileSync(f + '.tmp', JSON.stringify({ ...old, topic: old.topic || st.topic, items }, null, 1) + '\n');
    fs.renameSync(f + '.tmp', f);
    return { ok: true, total: items.length, left: items.filter((i) => !i.done).length };
  }

  function find(on) {
    if (!on) { st.finding = false; save(); return { ok: true }; }
    if (!kwLeft()) return { ok: false, reason: 'непройденных ключевиков нет — сначала подбери ключевики по теме' };
    if (!readers().length) {
      return { ok: false, reason: 'нет читателей: искать чаты будет аккаунт в роли «читатель» (вкладка «Аккаунты»)' };
    }
    st.finding = true; save();
    note('🔎', `поиск чатов по ключевикам: осталось ${kwLeft()}`);
    setTimeout(tick, 500);
    return { ok: true };
  }

  // tick — наружу только для песочницы (tests/sandbox/enrich_sched_test.mjs)
  return { view, leadsCsv, leadKeys, setOn, setGoal, addChats, chatsCmd, makeKeywords, saveKeywords, find, tick };
}
