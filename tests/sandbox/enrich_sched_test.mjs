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
];
const accounts = { list: () => accs, hasSession: () => true, isAuthed: () => true, fullRestLeft: () => 0 };
const running = new Map();
const launched = [];
const done = new Map();
const notes = [];
const pushes = [];

const writeChats = (obj) => fs.writeFileSync(path.join(DIR, 'enrich', 'chats.json'), JSON.stringify(obj));
const chatsOf = (spec) => Object.fromEntries(spec.map(([k, status]) => [k, { ref: k, status, chat_id: k.length }]));

const en = makeEnrich({
  DIR, CODE, accounts, running, pythonCmd: () => PY, push: (l) => pushes.push(l), readRaw: makeReadCsv(DIR),
  launch: (name, opts, onDone) => {
    launched.push([name, opts.account]);
    running.set(opts.account, { title: `${name === 'enrichFind' ? 'Поиск чатов' : 'Чтение чата'} — ${opts.account}` });
    done.set(opts.account, onDone);
    return { ok: true };
  },
  note: (i, t) => notes.push(t), busy: () => false, proxyDown: () => false,
});
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

console.log('\n▸ предел «читатели + 1»');
launched.length = 0;
finish('r1', 0, { done: 1 });
finish('r3', 0, { done: 1 });
writeChats(chatsOf([['c1', 'reading'], ['c2', 'reading'], ['c3', 'downloaded'], ['c4', 'downloaded'], ['c5', 'new']]));
running.clear();
// отдых после захода (20–60 с) снимаем, чтобы проверить именно предел
for (const id of ['r1', 'r3']) finish(id, 0, { cooldown: 0.001 });
await sleep(20);
en.tick();
check(!launched.some((x) => x[0] === 'enrichRead'), 'в работе 4 чата при 3 читателях — новых не берём');
await sleep(300);
check(pushes.some((l) => l.includes('▶ Разбор лидов')) && pushes.some((l) => l.includes('[лиды] разбираю')),
  'на выкачанный чат позван разбор, его вывод — в журнале');

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
fs.writeFileSync(path.join(DIR, 'leads.json'), JSON.stringify({
  1: { uid: 1, username: 'chmo', name: 'Иван', chats: [{ title: 'ЖК', why: 'берёт новостройку' }], note: 'ипотека', found_at: '2026-10-19' },
  4: { uid: 4, username: '', name: 'Оля', chats: [{ title: 'ЖК', why: 'да на вопрос' }], note: '', found_at: '2026-10-18' },
}));
fs.writeFileSync(path.join(DIR, 'chats', 'drafts.csv'), 'phone,account,ok,sent,at\n@chmo,w1,true,true,2026-10-19\n');
const k = en.leadKeys();
check(k.has('@chmo') && k.has('id:1') && k.has('id:4'), `ключи лидов: ${[...k]}`);
const L = en.view().leads;
check(L.find((l) => l.key === '@chmo')?.status === 'написали', 'статус «написали» из журнала рассылки');
check(L.find((l) => l.key === 'id:4')?.status === 'в очереди', 'лид без ника — «в очереди»');
check(en.leadsCsv().includes('берёт новостройку'), 'CSV с причиной');

console.log('\n▸ авто-выключение');
writeChats(chatsOf([['c1', 'done'], ['c2', 'error']]));
running.clear();
await sleep(600);       // разбор-заглушка мог ещё идти
en.tick();
check(!en.view().on, 'очередь пуста и всё разобрано — сбор выключился сам');

console.log(`\n${fails ? 'ПРОВАЛЕНО: ' + fails : 'ВСЁ ХОРОШО'}`);
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
