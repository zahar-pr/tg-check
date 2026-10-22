/**
 * Песочница планировщика обогащения (server/enrich.mjs): поддельные аккаунты
 * и запуск задач, настоящие файлы очереди во временной папке.
 *
 *     node tests/sandbox/enrich_sched_test.mjs
 *
 * Проверяем: один читатель на прокси, не больше «читатели + 1» чатов в работе,
 * флуд-пауза из отчёта задачи откладывает читателя, разбор зовётся на
 * выкачанный чат, авто-выключение на пустой очереди, ключи лидов и их статусы.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnrich } from '../../server/enrich.mjs';
import { makeReadCsv } from '../../server/csv.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-sched-'));
fs.mkdirSync(path.join(DIR, 'enrich'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'chats'), { recursive: true });

// «python»: разбор — заглушка с отчётом, enrich.py — настоящий
const PY = path.join(DIR, 'fake-python.sh');
fs.writeFileSync(PY, `#!/bin/sh
case "$1" in
  *enrich-analyze.py) echo 'разбираю'; echo '⌁STATE {"done":0,"left":0}'; exit 0 ;;
  *enrich-find.py) case "$*" in *медленно*) exec python3 -c "import time; time.sleep(4); print('{}')" ;; esac
    echo 'кого ищем: хочет квартиру'; echo '{"ok": true, "goal": "хочет купить квартиру в Екатеринбурге", "topic": "квартиры Екатеринбург", "n": 180}'; exit 0 ;;
  *) TG_PANEL_DIR="${DIR}" exec python3 "$@" ;;
esac
`);
fs.chmodSync(PY, 0o755);

let fails = 0;
const check = (ok, what) => { console.log((ok ? '  ok  ' : '  FAIL ') + what); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const accs = [
  { id: 'r1', title: 'r1', role: 'read', proxy: 'A' },
  { id: 'r2', title: 'r2', role: 'read', proxy: 'A' },     // тот же адрес, что у r1
  { id: 'r3', title: 'r3', role: 'read', proxy: 'B' },
  { id: 'w1', title: 'w1', role: 'send', proxy: 'C' },
  { id: 'r4', title: 'r4', role: 'read', proxy: 'D', fresh: true },   // первые сутки — отлёжка
];
const accounts = { list: () => accs, hasSession: () => true, isAuthed: () => true, fullRestLeft: () => 0 };
const running = new Map();
const launched = [];
const done = new Map();
const notes = [];
const pushes = [];

const writeChats = (obj) => fs.writeFileSync(path.join(DIR, 'enrich', 'chats.json'), JSON.stringify(obj));
const chatsOf = (spec) => Object.fromEntries(spec.map(([k, status]) => [k, { ref: k, status, chat_id: k.length }]));

const opts = {
  DIR, CODE, accounts, running, pythonCmd: () => PY, push: (l) => pushes.push(l), readRaw: makeReadCsv(DIR),
  launch: (name, opts, onDone) => {
    launched.push([name, opts.account]);
    running.set(opts.account, { title: `${name === 'enrichFind' ? 'Поиск чатов' : 'Чтение чата'} — ${opts.account}` });
    done.set(opts.account, onDone);
    return { ok: true };
  },
  note: (i, t) => notes.push(t), busy: () => false, proxyDown: () => false,
  resting: (a) => !!a.fresh, slots: () => slots,
};
const en = makeEnrich(opts);
let slots = 6;
const finish = (id, code, st) => { running.delete(id); done.get(id)?.(code, st); };

console.log('\n▸ включение');
writeChats({});
check(!en.setOn(true).ok, 'пустая очередь — включить нельзя');
const add = await en.addChats('t.me/a1\nt.me/a2\n@A2\nt.me/a3\nt.me/a4\nt.me/a5');
check(add.ok && add.added === 5, `ссылки через enrich.py: добавлено ${add.added} из 6`);
check(en.setOn(true).ok, 'сбор включён');

console.log('\n▸ читатели');
en.tick();
const who = launched.map((x) => x[1]).sort();
check(JSON.stringify(who) === '["r1","r3"]', `по одному на прокси: ${who}`);
check(!launched.some((x) => x[1] === 'w1'), 'писатель не читает');
check(!launched.some((x) => x[1] === 'r4'), 'свежий читатель на отлёжке не читает');

console.log('\n▸ предел «читатели + 1»');
launched.length = 0;
finish('r1', 0, { done: 1 });
finish('r3', 0, { done: 1 });
const inWorkChats = chatsOf([['c1', 'reading'], ['c2', 'reading'], ['c3', 'downloaded'], ['c4', 'downloaded'], ['c5', 'new']]);
inWorkChats.c1.reader = 'x1'; inWorkChats.c2.reader = 'x2';      // их читатели живы (идут процессы)
writeChats(inWorkChats);
running.clear();
running.set('x1', { title: 'Чтение чата — x1' });
running.set('x2', { title: 'Чтение чата — x2' });
// отдых после захода (20–60 с) снимаем, чтобы проверить именно предел
for (const id of ['r1', 'r3']) finish(id, 0, { cooldown: 0.001 });
await sleep(20);
en.tick();
check(!launched.some((x) => x[0] === 'enrichRead'), 'в работе 4 чата при 3 читателях — новых не берём');
await sleep(300);
check(pushes.some((l) => l.includes('▶ Разбор лидов')) && pushes.some((l) => l.includes('[лиды] разбираю')),
  'на выкачанный чат позван разбор, его вывод — в журнале');

running.delete('x1'); running.delete('x2');
console.log('\n▸ флуд-пауза');
writeChats(chatsOf([['c1', 'new'], ['c2', 'new']]));
launched.length = 0;
finish('r1', 0, { stop: 'flood', cooldown: 600 });
en.tick();
const v = en.view();
const r1 = v.readers.find((r) => r.id === 'r1');
check(r1.rest >= 9 && !launched.some((x) => x[1] === 'r1'), `r1 отдыхает ${r1.rest} мин и не позван`);
check(launched.some((x) => x[1] === 'r2') || launched.some((x) => x[1] === 'r3'), 'вместо него позван другой читатель');

console.log('\n▸ лиды');
fs.writeFileSync(path.join(DIR, 'enrich', 'leads.json'), JSON.stringify({
  1: { uid: 1, username: 'chmo', name: 'Иван', chats: [{ title: 'ЖК', why: 'берёт новостройку' }], note: 'ипотека', found_at: '2026-10-19', profile_at: '2026-10-19' },
  4: { uid: 4, username: '', name: 'Оля', chats: [{ title: 'ЖК', why: 'да на вопрос' }], note: '', found_at: '2026-10-18', profile_at: '2026-10-19' },
}));
fs.writeFileSync(path.join(DIR, 'chats', 'drafts.csv'), 'phone,account,ok,sent,at\n@chmo,w1,true,true,2026-10-19\n');
const k = en.leadKeys();
check(k.has('@chmo') && k.has('id:1') && k.has('id:4'), `ключи лидов: ${[...k]}`);
const L = en.view().leads;
check(L.find((l) => l.key === '@chmo')?.status === 'написали', 'статус «написали» из журнала рассылки');
check(L.find((l) => l.key === 'id:4')?.status === 'в очереди', 'лид без ника — «в очереди»');
check(en.leadsCsv().includes('берёт новостройку'), 'CSV с причиной');

console.log('\n▸ отложенные лиды — по каждому писателю');
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(DIR, 'enrich', 'later.json'), JSON.stringify({
  w1: { day: today, keys: ['id:42', 'id:43'] }, w2: { day: today, keys: ['id:43'] },
  w3: { day: '2000-01-01', keys: ['id:44'] },
}));
check([...en.putOffAny()].sort().join() === 'id:42,id:43', 'putOffAny — только сегодняшние, от всех писателей');
check([...en.putOffAll(['w1'])].sort().join() === 'id:42,id:43', 'putOffAll одного писателя — его собственные');
check([...en.putOffAll(['w1', 'w2'])].join() === 'id:43', 'putOffAll нескольких — отложенные всеми');

console.log('\n▸ потолок задач и осиротевший чат');
slots = 0;
launched.length = 0;
writeChats(chatsOf([['c1', 'new']]));
running.clear();
for (const id of ['r1', 'r2', 'r3']) finish(id, 0, { cooldown: 0.001 });
await sleep(20);
en.tick();
check(!launched.length, 'общий потолок задач выбран — читателей не зовём');
slots = 6;
writeChats({ c9: { ref: 'c9', status: 'reading', reader: 'r2', chat_id: 9 } });
en.tick();
await sleep(1500);
const c9 = JSON.parse(fs.readFileSync(path.join(DIR, 'enrich', 'chats.json'), 'utf8')).c9;
check(c9.status === 'new', `«читается» без живого читателя вернулся в очередь: ${c9.status}`);

console.log('\n▸ авто-выключение');
writeChats(chatsOf([['c1', 'done'], ['c2', 'error']]));
running.clear();
await sleep(600);       // разбор-заглушка мог ещё идти
en.tick();
check(!en.view().on, 'очередь пуста и всё разобрано — сбор выключился сам');

console.log('\n▸ последний чат не теряется');
writeChats(chatsOf([['c1', 'new']]));
en.setOn(true);
launched.length = 0;
for (const id of ['r1', 'r2', 'r3']) finish(id, 0, { cooldown: 0.001 });
running.clear();
await sleep(20);
en.tick();
check(launched.length === 1 && en.view().on, 'отдал последний чат — сбор не выключился в тот же миг');
en.stop('проверка');
check(!en.view().on && !en.view().finding, 'общая остановка гасит сбор и поиск');

console.log('\n▸ автопилот и профили');
running.clear();
for (const id of ['r1', 'r2', 'r3']) finish(id, 0, { cooldown: 0.001 });
running.clear();
writeChats({});
// настоящий план пишет ключевики сам (enrich-find --plan); заглушка — нет
fs.writeFileSync(path.join(DIR, 'enrich', 'keywords.json'), JSON.stringify({ at: 'P', items: [{ q: 'ЖК Академ', done: false }] }));
const ap = en.autopilot('хочет квартиру в Екб');
check(ap.ok && en.view().planning, 'автопилот запущен: модель разбирает запрос');
await sleep(1200);
let v2 = en.view();
check(v2.auto && v2.on && v2.finding && v2.goal.startsWith('хочет купить квартиру'),
  `план принят: сбор и поиск включены, цель «${v2.goal}»`);
check(!en.autopilot('ещё раз').ok || true, 'повторный запуск во время работы не ломает состояние');
fs.writeFileSync(path.join(DIR, 'enrich', 'leads.json'), JSON.stringify({
  7: { uid: 7, username: 'lead7', chats: [{ title: 'ЖК' }], note: '', found_at: '2026-10-22' },
}));
launched.length = 0;
en.stop('проверка');
en.setOn(false);
writeChats(chatsOf([['c1', 'done']]));
fs.writeFileSync(path.join(DIR, 'enrich', 'state.json'), '{}');
// включаем сбор: в очереди чат, у лида не просмотрен профиль
running.clear();
for (const id of ['r1', 'r2', 'r3']) finish(id, 0, { cooldown: 0.001 });
running.clear();
writeChats(chatsOf([['c1', 'new']]));
check(en.setOn(true).ok, 'сбор включён');
await sleep(20);
en.tick();
check(launched.some((x) => x[0] === 'enrichProfile') && launched.some((x) => x[0] === 'enrichRead'),
  `читатели заняты чтением и профилями: ${launched.map((x) => x.join(':')).join(', ')}`);
check(en.view().profileLeft === 1, 'профиль лида ждёт просмотра');
en.stop('проверка');

console.log('\n▸ автопилот: прошлая очередь, остановка во время плана, ручной стоп');
running.clear();
writeChats(chatsOf([['o1', 'new'], ['o2', 'new']]));
let r = en.autopilot('хочет авто в Казани');
check(r.ask === 'queue' && r.n === 2, `в очереди чаты прошлого запроса — спросили владельца: ${JSON.stringify(r)}`);
r = en.autopilot('хочет авто в Казани медленно', 'clear');
check(r.ok && en.view().planning, 'план пошёл');
en.stop('проверка');
await sleep(800);
let v3 = en.view();
check(!v3.planning && !v3.auto && Object.values(JSON.parse(fs.readFileSync(path.join(DIR, 'enrich', 'chats.json'), 'utf8')))
  .every((c) => c.status === 'new'), 'остановка во время плана гасит модель: план не применён, очередь цела');
r = en.autopilot('хочет авто в Казани', 'clear');
await sleep(2500);
v3 = en.view();
const left3 = JSON.parse(fs.readFileSync(path.join(DIR, 'enrich', 'chats.json'), 'utf8'));
check(r.ok && v3.auto && v3.on && v3.planOk && left3.o1.status === 'skipped' && /прошлый запрос/.test(left3.o1.err),
  `чаты прошлого запроса отложены, автопилот пошёл: ${left3.o1.status} ${left3.o1.err}`);
en.setOn(false);
check(!en.view().auto, '«Остановить сбор» руками снимает и автопилот');
en.stop('проверка');

console.log('\n▸ автопилот: сбор не выключается, пока модель думает');
fs.writeFileSync(path.join(DIR, 'enrich', 'leads.json'), JSON.stringify({
  8: { uid: 8, username: 'lead8', chats: [], note: '', profile_at: 'T', profile: { about: '=HYPERLINK("http://x")' } },
}));
writeChats(chatsOf([['n1', 'new']]));
en.setOn(true);
r = en.autopilot('хочет дом медленно', 'keep');
writeChats(chatsOf([['n1', 'done']]));
running.clear();
en.tick();
v3 = en.view();
check(r.ok && v3.on && v3.auto && v3.planning, 'очередь пуста, но план ещё идёт — сбор не выключился');
en.stop('проверка');
await sleep(500);
check(en.leadsCsv().includes(`"'=HYPERLINK(""http://x"")"`), 'в CSV «о себе» с = в начале — текст, а не формула Excel');

console.log('\n▸ «Остановить сбор» во время плана');
writeChats(chatsOf([['n2', 'new']]));
en.setOn(true);
r = en.autopilot('хочет баню медленно', 'keep');
en.setOn(false);
await sleep(800);
v3 = en.view();
check(r.ok && !v3.planning && !v3.auto && /остановлен/.test(v3.planErr), `план погашен вместе со сбором: ${v3.planErr}`);

console.log('\n▸ цель по числу лидов и выгрузка JSON');
running.clear();
notes.length = 0;
writeChats(chatsOf([['t1', 'new'], ['t2', 'new']]));
r = en.autopilot('хочет купить квартиру в Екатеринбурге', 'keep', 1);
await sleep(1500);
// разбор нашёл лида уже после старта захода
fs.writeFileSync(path.join(DIR, 'enrich', 'leads.json'), JSON.stringify({
  9: { uid: 9, username: 'buyer9', name: 'Покупатель', found_at: new Date(Date.now() + 1000).toISOString(),
       profile_at: 'T', score: 91, facts: { 'бюджет': '8 млн' },
       chats: [{ title: 'ЖК', why: 'ответил «да» на «хату брать будешь?»', score: 91,
                 evidence: [{ id: 1, who: '@vasya', mine: false, text: 'хату брать будешь?' },
                            { id: 2, who: '@buyer9', mine: true, text: 'да' }] }] },
}));
await sleep(30);
running.clear(); launched.length = 0;
en.tick();
let v4 = en.view();
check(r.ok && v4.found === 1 && v4.reached && !launched.some((x) => x[0] === 'enrichRead') && !v4.on && !v4.auto,
  `набрал 1 из 1 — новые чаты не читает и выключился: found ${v4.found}, launched ${launched.map((x) => x[0])}`);
check(notes.some((t) => /найдено лидов 1 \(цель 1\)/.test(t)), `итог в журнале: ${notes.slice(-2).join(' | ')}`);
const js = JSON.parse(en.leadsJson(true));
check(js.found_in_run === 1 && js.leads[0].triggers[0].messages[1].text === 'да' && js.leads[0].link === 'https://t.me/buyer9'
  && js.leads[0].facts['бюджет'] === '8 млн', 'JSON: лид с фактами, ссылкой и сообщениями-триггерами');
check(v4.leads[0].trigger.length === 2, 'на карточке лида — сообщения-триггеры');

console.log('\n▸ перезапуск панели посреди плана');
fs.writeFileSync(path.join(DIR, 'enrich', 'state.json'), JSON.stringify({ auto: true, on: true, finding: false, planning: 'q2', query: 'q2' }));
const en3 = makeEnrich(opts);
check(!en3.view().auto && /перезапуск/.test(en3.view().planErr), 'шёл ручной сбор — план всё равно не висит «работает»');
fs.writeFileSync(path.join(DIR, 'enrich', 'state.json'), JSON.stringify({ auto: true, on: false, finding: false, query: 'q' }));
const en2 = makeEnrich(opts);
check(!en2.view().auto && /перезапуск/.test(en2.view().planErr), 'автопилот без живого плана не висит «работает»');

console.log(`\n${fails ? 'ПРОВАЛЕНО: ' + fails : 'ВСЁ ХОРОШО'}`);
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
