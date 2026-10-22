/**
 * Панель: весь клиентский код.
 *
 * Схема простая: раз в две секунды опрашиваем сервер (loop внизу файла) и
 * перерисовываем то, что изменилось. Никаких фреймворков — панель одна,
 * состояний немного, а так её правит любой, кто читает JavaScript.
 */

/*
 * КАРТА ФАЙЛА — экраны идут сверху вниз в том же порядке, что в панели.
 *
 *    123  АККАУНТЫ — строка аккаунта и кнопки при ней
 *    453  СОСТОЯНИЕ — счётчики, прогресс, кто чем занят
 *    562  ТЕКСТЫ ПИСЕМ, ЗЕРКАЛА, ГОЛОСОВОЕ
 *    764  РЕЗУЛЬТАТЫ — сводка, дни, ответы
 *   1049  ЗАПУСК РАССЫЛКИ
 *   1338  БАЗА ПОЛУЧАТЕЛЕЙ — файл с номерами и люди из чатов
 *   1476  ПРОГРЕВ — расписание, срок, смена IP
 *   1736  ОТКРЫТЬ АККАУНТ НА СВОЁМ КОМПЬЮТЕРЕ
 *   1997  РЕЖИМЫ (боковая панель)
 *   2021  ОБЗОР + КАЛЬКУЛЯТОР МОЩНОСТИ
 *   2140  СКАЧИВАНИЕ СПИСКОВ (по запросу, не вживую)
 *
 * Всё рисуется опросом раз в две секунды (см. loop внизу файла):
 * панель спрашивает сервер и перерисовывает только то, что изменилось.
 */
const $ = s => document.querySelector(s);
let logFrom = 0, busy = false, accs = [], accsRaw = '';
let cur = localStorage.getItem('tg-account') || '';

const post = (url, data) => fetch(url, {
  method: 'POST',
  headers: {'content-type': 'application/json', 'x-panel': '1'},
  body: JSON.stringify(data || {}),
}).then(r => { if (r.status === 401) { location.href = '/login'; throw new Error('нужен вход'); } return r.json(); });

const pick = (id) => { cur = id; localStorage.setItem('tg-account', id); accsRaw = ''; paintAccounts(); };

/** Текст из чужих рук (имя из Telegram, название аккаунта) в разметку — только так. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Вошёл или нет — это первое, что нужно видеть в списке. */
const accReady = (a) => a.session && a.authed;
// какие прокси сторож сейчас считает лежащими (по подписи без пароля) — из state()
let proxyDownLabels = new Set();
const accBadge = (a) =>
  // «Подключение сессии — Вася» в бейдж не влезает и дёргает вёрстку;
  // при заливке показываем короткое и понятное
  a.busy && /Подключение сессии/i.test(a.busy) ? '<span class="st st-run">подключаю…</span>'
  : a.busy ? `<span class="st st-run">${esc(a.busy)}</span>`
  // карантин важнее «вошёл»: аккаунт живой, но писать с него нельзя,
  // и человек должен видеть это первым, а не искать в журнале
  : a.quarantine ? `<span class="st st-no">${a.spamUntil
      ? 'ограничен до ' + new Intl.DateTimeFormat('ru-RU', {timeZone: 'Asia/Yekaterinburg',
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).format(new Date(a.spamUntil))
      : a.spamKind === 'frozen' ? 'заморожен' : a.spamKind === 'perm' ? 'ограничен бессрочно' : 'ограничен'}</span>`
  // «вошёл» — это только файл сессии; без живого прокси работать он не будет
  : accReady(a) && !a.proxy ? '<span class="st st-no" title="Прокси не задан — аккаунт пойдёт в Telegram с IP сервера">без прокси</span>'
  : accReady(a) && proxyDownLabels.has(a.proxyLabel) ? '<span class="st st-no">прокси не отвечает</span>'
  : accReady(a) ? '<span class="st st-ok">вошёл</span>'
  : a.profile && !a.session ? '<span class="st st-no">нужен перенос</span>'
  // файл сессии есть, а входа нет — Telegram отозвал ключ панели
  : a.session && !a.authed ? '<span class="st st-no" title="Telegram отозвал ключ панели — нужен новый вход">сессия отозвана</span>'
  : '<span class="st st-no">не вошёл</span>';

/**
 * Прогрев одной строкой. Свежий аккаунт нельзя сразу гнать в рассылку —
 * панель ведёт его по расписанию, и человеку надо видеть, где он сейчас.
 */
/**
 * Остаток времени словами.
 *
 * Минуты округляем ПОСЛЕ разбора на часы, иначе 86 398 секунд превращаются
 * в «23 ч 60 мин»: минуты округлились до шестидесяти, а часы этого уже не
 * увидели. Мало того что неправда — строка дёргалась туда-сюда на каждом
 * опросе, и список аккаунтов мигал.
 */
const agoJs = (ts) => {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 90) return 'только что';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} мин назад` : `${(m / 60).toFixed(1)} ч назад`;
};
const fmtLeftJs = (sec) => {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
};
const warmLine = (a) => {
  const ekbAt = (t) => new Intl.DateTimeFormat('ru-RU', {timeZone: 'Asia/Yekaterinburg',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).format(new Date(t));
  // ключ панели отозван (часто — «завершить другие сеансы» на другом устройстве):
  // прогон его выкинул, писать он не может, пока не войти заново
  if (a.session && !a.authed) return '⛔ Telegram отозвал сессию — войди заново: «Войти по коду» или «⋯ → Залить сессию»';
  if (a.restUntil) return `😴 отдыхает после заморозки до ${ekbAt(a.restUntil)} — в Telegram не заходит`;
  if (a.holdUntil) return `🌿 после заморозки до ${ekbAt(a.holdUntil)} только греется, людям не пишет`;
  if (a.quarantine) {
    // полный ответ SpamBot — в подсказке: в строке он занимал три строчки
    const tip = esc((a.spam || '').slice(0, 300));
    return `<span title="${tip}">` + (a.spamKind === 'frozen' ? '⛔ заморожен — нужен разбан через @SpamBot'
      : a.spamKind === 'perm' ? '⛔ ограничен бессрочно'
      : '⛔ ограничен — вернётся в рассылку сам') + '</span>';
  }
  const w = a.warm;
  if (!w) return '';
  if (w.resting) return `🌱 новый, отлёживается ещё ${fmtLeftJs(w.restLeft)}`;
  // прогрев и рассылка — разные часы: первый считает возраст аккаунта, вторая —
  // дни, когда он реально пишет людям
  const warmTxt = w.day >= w.fullDay ? 'прогрет' : `прогрев ${w.day} из ${w.fullDay} дн.`;
  const od = typeof a.outreachDay === 'number' ? a.outreachDay : -1;
  const outTxt = a.role === 'warm' ? '' : od < 0 ? ' · ещё не писал' : ` · пишет до ${w.cap} в день`;
  const now = a.now ? `<br>▸ ${esc(a.now)}` : '';
  return `🌱 ${warmTxt}${outTxt}${now}`;
};

/** Кто это на самом деле: имя, @ и телефон — их отдаёт Telegram при входе. */
// под крупным именем — номер, @ник и ярлык панели (если он не совпадает с номером)
const accSub = (a) => {
  const phone = a.phone ? '+' + String(a.phone).replace(/^\+/, '') : '';
  const parts = [phone, a.username ? '@' + a.username : '',
                 a.name && a.title && a.title !== phone ? a.title : ''].filter(Boolean);
  return parts.length ? parts.map(esc).join(' · ') : accWho(a);
};
const accWho = (a) => {
  const who = [a.name, a.username ? '@' + a.username : '', a.phone ? '+' + String(a.phone).replace(/^\+/, '') : '']
    .filter(Boolean).map(esc).join(' · ');
  if (who) return who;
  return accReady(a) ? 'данные аккаунта появятся после первой задачи'
       : a.profile && !a.session ? 'нажми «На Telethon» — вход перенесётся без QR'
       : 'войди по QR или залей готовую сессию';
};

// меню «⋯»: пункт нажат или клик мимо — закрываем; открытым держим одно
document.addEventListener('click', (e) => {
  const inMenu = e.target.closest('.accmenu');
  document.querySelectorAll('.accmenu[open]').forEach(d => {
    if (d !== inMenu || e.target.closest('.accmenu-list button')) d.open = false;
  });
  // пока меню было открыто, список мог отстать — догоняем
  setTimeout(() => { if (!document.querySelector('#accs .accmenu[open]')) paintAccounts(); }, 0);
});

let accsHtml = '';        // что уже нарисовано: лишний раз DOM не трогаем
/* ═══════════ АККАУНТЫ — строка аккаунта и кнопки при ней ═══════════ */


function paintAccounts() {
  if (!accs.length) {
    accsHtml = '';
    $('#accs').innerHTML = '<p style="color:var(--mut);margin:0">Пока ни одного — нажми «Добавить аккаунт».</p>';
    $('#acct').innerHTML = '<b style="color:var(--no)">аккаунт не подключён</b>';
    $('#s1').classList.remove('done');
    return;
  }
  if (!accs.some(a => a.id === cur)) cur = accs[0].id;
  // кого пустить в работу, выбирают вкладки рассылки — здесь только показ
  if (work === null) useWork(pickSet);
  // роль: прогрев идёт у всех, в рассылку попадают только отмеченные ✉️
  // роль — переключатель: прогрев идёт у всех, в рассылку попадают только ✉️
  const rolePill = (a) => a.role === 'read'
    ? `<span class="daypill rolepill read" data-role="${a.id}" title="Читатель: читает чаты для поиска лидов, людям не пишет и не греется. Нажми — вернуть в прогрев">📖 читатель</span>`
    : a.role === 'warm'
    ? `<span class="daypill rolepill warm" data-role="${a.id}" title="Только греется. Нажми — взять в рассылку">🌱 только прогрев</span>`
    : `<span class="daypill rolepill" data-role="${a.id}" title="Греется и пишет людям. Нажми — оставить только прогрев">✉️ рассылка</span>`;
  // где аккаунт сейчас занят — чтобы не искать его по вкладкам
  const where = (a) => a.run === 'chats' ? '<span class="tag">▶ по чатам</span>'
    : a.run === 'phones' ? '<span class="tag">▶ по номерам</span>' : '';
  // редкие действия — в меню «⋯», на виду только то, что нужно часто
  const item = (attr, id, text, busy = true) =>
    `<button class="ghost mini" data-${attr}="${id}"${busy ? ' data-busy' : ''}>${text}</button>`;
  // сколько аккаунтов делят один выходной IP — чтобы подсветить дубли
  const ipCount = {};
  for (const a of accs) if (a.exitIp) ipCount[a.exitIp] = (ipCount[a.exitIp] || 0) + 1;
  // строка про IP/прокси: показываем реальный выходной адрес и страну, красным —
  // если IP повторяется у другого аккаунта или выход не из Казахстана
  const ipLine = (a) => {
    if (a.exitIp) {
      const warn = (a.exitCountry && a.exitCountry !== 'KZ') ? ` <span style="color:var(--no)">⚠ ${esc(a.exitCountry)}</span>` : '';
      const dup = ipCount[a.exitIp] > 1 ? ' <span style="color:var(--no)">⚠ дубль IP</span>' : '';
      const ok = !warn && !dup ? ' <span style="color:var(--acc)">✓</span>' : '';
      return `IP ${esc(a.exitIp)}${a.exitCountry ? ' ' + esc(a.exitCountry) : ''}${warn}${dup}${ok}`;
    }
    if (a.proxy) return 'прокси ' + esc(String(a.proxyLabel).replace(/\s*\(.*\)$/, '')) + ' <span class="hint">(IP проверяется…)</span>';
    return '<span style="color:var(--no)">без прокси</span>';
  };
  const html = accs.map(a => `
    <div class="acc ${a.id === cur ? 'sel' : ''}">
      ${a.avatar ? `<img class="ava" src="/api/avatar?id=${a.id}&v=${a.avatar}" alt="">`
        : `<span class="ava ava-none">${esc((a.name || a.title || '?').trim().charAt(0).toUpperCase())}</span>`}
      <span class="nm"><b class="acc-name">${esc(a.name || a.title)} ${accBadge(a)} ${
          accReady(a) ? rolePill(a) : ''} ${where(a)}</b>
        <span class="${accReady(a) ? 'on' : 'off'}">${accSub(a)}</span>
        <span>${ipLine(a)} · написал ${a.sent}${
          a.dailyCap ? ` · свой предел ${a.dailyCap} в день` : ''}${
          a.channelOn && a.channel ? ` · в профиле канал @${esc(a.channel)}` : ''}</span>
        <span class="hint" title="Отпечаток устройства — чем аккаунт представляется Telegram">🖥 ${esc(a.fp || '')}</span>
        <span class="warm ${a.quarantine || (a.warm && a.warm.resting) ? 'off' : ''}">${warmLine(a)}</span></span>
      <span class="accbtns">${
        accReady(a) ? '' : item('code', a.id, 'Войти по коду')}${
        a.profile && !a.session ? item('mig', a.id, 'На Telethon') : ''}
        ${item('pckit', a.id, 'На ПК', false)}
        ${item('prx', a.id, 'Прокси')}
        <details class="accmenu"><summary class="ghost mini" title="Ещё действия">⋯</summary>
          <span class="accmenu-list">
            ${item('tgname', a.id, 'Имя в Telegram')}
            ${item('tguser', a.id, '@ник')}
            ${item('tgabout', a.id, 'Описание профиля')}
            ${item('tgchan', a.id, a.channelOn && a.channel ? `Канал в профиле (@${esc(a.channel)})` : 'Канал-прокладка в профиль')}
            ${item('tgpic', a.id, 'Аватарка')}
            ${item('desk', a.id, 'Открыть в Desktop')}
            ${item('chk', a.id, 'Проверить прокси')}
            ${item('imp', a.id, 'Залить сессию')}
            ${a.warm && a.role !== 'warm' ? item('cap', a.id, 'Предел писем в день', false) : ''}
            ${item('ren', a.id, 'Название в панели')}
            ${item('del', a.id, 'Убрать аккаунт')}
          </span>
        </details>
      </span>
    </div>`).join('');

  /**
   * Перерисовываем, ТОЛЬКО если разметка изменилась.
   *
   * Список аккаунтов панель опрашивает каждые две секунды, а в ответе всегда
   * что-то дёргается — секунды до конца отлёжки, счётчик броней. Раньше это
   * означало полную перестройку разметки каждые две секунды: строки мигали,
   * и особенно противно это выглядело как раз при подключении аккаунтов,
   * когда смотреть на них и хочется.
   */
  if (html === accsHtml) return;
  // открыто меню «⋯» — не перерисовываем: иначе оно закрывалось бы на каждом
  // опросе (раз в 2 с), и до пункта было не дотянуться. Нарисуем, когда закроют
  if ($('#accs').querySelector('.accmenu[open]')) return;
  accsHtml = html;
  $('#accs').innerHTML = html;

  document.querySelectorAll('[data-ren]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.ren);
    const t = prompt('Как назвать этот аккаунт?', a.title);
    if (t) { await post('/api/accounts/rename', {id: a.id, title: t}); loop(); }
  });
  document.querySelectorAll('[data-role]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.role);
    if (a.role === 'read') {
      if (!confirm(`«${a.name || a.title}» сейчас читатель. Вернуть его в прогрев? Читать чаты для лидов он перестанет.`)) return;
      const r = await post('/api/accounts/role', {id: a.id, role: 'warm'});
      if (r && r.ok === false) alert(r.reason || 'не получилось');
      loop();
      return;
    }
    const toSend = a.role === 'warm';
    if (toSend && a.warm && !a.warm.atMax &&
        !confirm(`«${a.name || a.title}» ещё не прогрет (день ${a.warm.day} из ${a.warm.fullDay}). Всё равно перевести в рассылку?`)) return;
    const r = await post('/api/accounts/role', {id: a.id, role: toSend ? 'send' : 'warm'});
    if (r && r.ok === false) alert(r.reason || 'не получилось');   // например, отдых после заморозки
    loop();
  });
  // дневной лимит сообщений на конкретный аккаунт (для тестов). 0 — как у всех
  document.querySelectorAll('[data-cap]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.cap);
    const cur = a.dailyCap || 0;
    const v = prompt(`Сколько сообщений в сутки писать аккаунтом «${esc(a.title)}»?\n\n` +
      `Сейчас: ${cur > 0 ? cur + ' (свой лимит)' : 'как у всех (по прогреву)'}.\n` +
      `Введи число, или 0 — чтобы вернуть общий лимит.`, String(cur));
    if (v === null) return;
    await post('/api/accounts/dailycap', {id: a.id, cap: Math.max(0, parseInt(v) || 0)});
    loop();
  });
  // Профиль в самом Telegram — тем же ключом, которым работает панель.
  // Разнесено по кнопкам: чаще всего нужно что-то одно, а не всё сразу.
  document.querySelectorAll('[data-tgname]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.tgname);
    const name = prompt(`Имя в Telegram для «${esc(a.title)}»\n\nТак его увидят люди, которым пишем.`, a.name || '');
    if (name === null || !name.trim()) return;
    const last = prompt('Фамилия (можно пусто):', '');
    if (last === null) return;
    const r = await post('/api/accounts/profile', {id: a.id, name: name.trim(), last: last.trim()});
    if (!r.ok) alert(r.reason || 'не удалось'); else state();
  });

  document.querySelectorAll('[data-tguser]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.tguser);
    const u = prompt(`@username для «${esc(a.title)}» — без «собаки».\n\n` +
      '5–32 знака, латиница, цифры и _. Если занят, Telegram откажет.',
      a.username || '');
    if (u === null || !u.trim()) return;
    const r = await post('/api/accounts/profile', {id: a.id, username: u.trim().replace(/^@/, '')});
    if (!r.ok) alert(r.reason || 'не удалось'); else alert('Меняю @ — результат смотри в журнале.');
    state();
  });

  // «О себе»: без премиума — до 70 знаков, ссылки в нём не кликаются
  document.querySelectorAll('[data-tgabout]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.tgabout);
    const t = prompt(`Описание «о себе» для «${esc(a.title)}» — до 70 знаков.\n\n` +
      'Без премиума ссылки в описании не нажимаются — ссылку на канал лучше дать каналом-прокладкой.',
      a.about || '');
    if (t === null) return;
    if (t.length > 70 && !confirm(`${t.length} знаков: без премиума Telegram примет только 70. Всё равно отправить?`)) return;
    const r = await post('/api/accounts/profile', {id: a.id, about: t.trim()});
    if (!r.ok) alert(r.reason || 'не удалось'); else state();
  });

  // Канал-прокладка: свой маленький публичный канал аккаунта в профиле (это бесплатно
  // всем, но только СВОЙ канал), в нём закреплённый пост со ссылкой на основной канал
  document.querySelectorAll('[data-tgchan]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.tgchan);
    if (a.channelOn && a.channel) {
      const what = prompt(`В профиле «${esc(a.title)}» стоит канал @${a.channel}.\n\n` +
        '  1 — новый пост / поменять название или ник\n  2 — убрать канал из профиля\n\nВведи 1 или 2:', '1');
      if (what === null) return;
      if (what.trim() === '2') {
        const r = await post('/api/accounts/channel', {id: a.id, off: true});
        if (!r.ok) alert(r.reason || 'не удалось'); else state();
        return;
      }
    }
    const title = prompt('Название канала-прокладки (его видно в профиле):',
      a.channelTitle || 'Недвижимость Екатеринбурга');
    if (title === null || !title.trim()) return;
    const suggest = a.channel || ('ekb_' + String(a.username || a.id).toLowerCase().replace(/[^a-z0-9_]/g, '') + '_notes');
    const uname = prompt('Публичный @ник канала — латиница, цифры и _, 5–32 знака.\n' +
      'В профиль Telegram ставит только публичный канал.', suggest);
    if (uname === null || !uname.trim()) return;
    let saved = '';
    try { saved = localStorage.getItem('tg-bridge-post') || ''; } catch {}
    const text = prompt('Текст закреплённого поста со ссылкой на основной канал.\n\n' +
      'Лучше своя ссылка-приглашение на каждый аккаунт (в основном канале: Управление → ' +
      'Пригласительные ссылки) — тогда видно, кто сколько привёл.' +
      (a.channel ? '\nПусто — пост не меняем.' : ''),
      saved || 'Подборки квартир и разборы сделок в Екатеринбурге — в канале: ссылка');
    if (text === null) return;
    try { if (text.trim()) localStorage.setItem('tg-bridge-post', text.trim()); } catch {}
    const r = await post('/api/accounts/channel', {id: a.id, title: title.trim(), username: uname.trim(), post: text.trim()});
    if (!r.ok) alert(r.reason || 'не удалось'); else alert('Делаю — что вышло, смотри в журнале.');
    state();
  });

  document.querySelectorAll('[data-tgpic]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.tgpic);
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      $('#status-t').textContent = 'ставлю аватарку…';
      const res = await fetch('/api/accounts/photo?account=' + encodeURIComponent(a.id), {
        method: 'POST',
        headers: {'x-filename': encodeURIComponent(inp.files[0].name), 'x-panel': '1'},
        body: inp.files[0],
      }).then(r => r.json()).catch(() => ({ok: false}));
      if (!res.ok) alert(res.reason || 'не удалось загрузить аватарку');
      state();
    };
    inp.click();
  });

  /**
   * Открыть аккаунт в Telegram Desktop. Два шага не ради красоты: если пустить
   * десктоп сразу с аккаунтом, он сходит в Telegram с настоящего IP, а панель
   * ходит через прокси — одна авторизация из двух стран, и сессию отзывают.
   * Поэтому сначала пустой запуск для настройки прокси, потом уже с аккаунтом.
   */
  document.querySelectorAll('[data-pckit]').forEach(b => b.onclick = (e) => {
    e.preventDefault();
    openKit(b.dataset.pckit);
  });

  document.querySelectorAll('[data-desk]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.desk);
    const how = prompt(
      `Открыть «${esc(a.title)}» в Telegram Desktop.\n\n` +
      `Аккаунт ходит через: ${esc(a.proxyLabel)}\n` +
      `Если десктоп выйдет в сеть мимо этого прокси — Telegram увидит одну\n` +
      `авторизацию с двух разных IP и может отозвать сессию.\n\n` +
      `  1 — ПОДГОТОВИТЬ: запустить десктоп пустым (без аккаунта),\n` +
      `      прописать в нём прокси и закрыть. Светить нечего.\n` +
      `  2 — ОТКРЫТЬ аккаунт (только после шага 1).\n\n` +
      `Введи 1 или 2:`, '1');
    if (how === null) return;
    const step = how.trim() === '2' ? 'open' : 'proxy';
    const r = await post('/api/accounts/desktop', {id: a.id, step});
    if (!r.ok) { alert(r.reason || 'не удалось'); return; }

    if (step === 'proxy') {
      alert('Десктоп открыт ПУСТЫМ — аккаунта в нём пока нет.\n\n' +
        'Сделай так:\n' +
        `  Настройки → Продвинутые → Тип соединения → Свой прокси\n` +
        `  SOCKS5, укажи: ${a.proxyLabel}\n\n` +
        'Потом закрой окно Telegram и нажми эту кнопку снова, выбрав 2.');
      await post('/api/accounts/desktop/ready', {id: a.id});
      return;
    }
    if (!r.warmed && !confirm('Похоже, прокси в этой папке ещё не настраивали (шаг 1).\n\n' +
        'Открыть всё равно? Аккаунт может выйти в сеть с твоего IP.')) return;
    alert('Открываю в Telegram Desktop.\n\nУчти: ключ у десктопа и у панели общий — ' +
      'не выходи там из аккаунта, иначе панель тоже потеряет сессию.');
  });

  // вход по номеру для уже заведённого аккаунта: тот же способ, что и при
  // добавлении, — нужен, когда QR отсканировать нечем
  document.querySelectorAll('[data-code]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.code);
    const tel = prompt(`Номер аккаунта «${a.title}» — с кодом страны.\n\nНапример: +79001112233`,
                       a.phone ? '+' + String(a.phone).replace(/^\+/, '') : '+7');
    if (tel === null) return;
    const r = await post('/api/start', {name: 'code', account: a.id, phone: tel});
    if (!r.ok) { alert(r.reason || 'не удалось'); return; }
    alert('Telegram отправляет код. Как придёт — панель спросит его сама,\nздесь же, отдельным окном.');
    loop();
  });

  document.querySelectorAll('[data-prx]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.prx);
    const t = prompt(`Через какой прокси ходит «${a.title}»?\n\nФормат: host:port  либо  host:port:логин:пароль\nМожно с протоколом: socks5://host:port\n\nПустая строка — ходить напрямую, со своего IP.`, a.proxy);
    if (t === null) return;
    const r = await post('/api/accounts/proxy', {id: a.id, proxy: t});
    if (!r.ok) alert(r.reason || 'не удалось');
    else { if (r.warn) alert(r.warn); accsRaw = ''; loop(); }
  });
  document.querySelectorAll('[data-imp]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.imp);
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.zip,.session';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      const res = await importFile(a.id, inp.files[0]);
      if (!res.ok) alert(res.reason || 'не удалось загрузить');
      else alert(`Файл принят как ${res.kind}. Подключаю сессию «${a.title}» — смотри журнал.`);
      loop();
    };
    inp.click();
  });
  document.querySelectorAll('[data-mig]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.mig);
    if (!confirm(`Перенести «${a.title}» на прямой канал Telegram?\n\nКлюч возьмётся из уже открытой сессии браузера — сканировать QR заново не нужно. Займёт несколько секунд.`)) return;
    const r = await post('/api/start', {name: 'migrate', account: a.id});
    if (!r.ok && r.reason) alert(r.reason);
    state();
  });
  document.querySelectorAll('[data-chk]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const r = await post('/api/start', {name: 'proxy', account: b.dataset.chk});
    if (!r.ok && r.reason) alert(r.reason);
    state();
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.del);
    if (!confirm(`Отключить «${a.title}»?\n\nСессия на этом компьютере удалится — чтобы вернуть аккаунт, придётся снова входить по QR. Собранные номера и история сообщений останутся.`)) return;
    const r = await post('/api/accounts/remove', {id: a.id});
    if (!r.ok) alert(r.reason || 'не удалось'); else loop();
  });

  const ready = accs.filter(accReady);
  const inP = accs.filter(x => x.run === 'phones'), inC = accs.filter(x => x.run === 'chats');
  const free = ready.filter(x => !x.run && x.role !== 'warm' && x.role !== 'read');
  $('#acct').innerHTML = ready.length
    ? `Вошли: <b style="color:var(--ok)">${ready.map(x => esc(x.title)).join(', ')}</b>`
    : '<b style="color:var(--no)">ни один аккаунт не вошёл</b>';
  // где кто занят — состав набирают вкладки рассылки, здесь только итог
  $('#selcount').innerHTML = !ready.length
    ? 'Ни один аккаунт не вошёл — подключи хотя бы один.'
    : [inP.length ? `<b>${inP.length}</b> в рассылке по номерам` : '',
       inC.length ? `<b>${inC.length}</b> по чатам` : '',
       `свободны <b>${free.length}</b>`].filter(Boolean).join(' · ');
  $('#s1').classList.toggle('done', ready.length > 0);
}

/**
 * Вход по номеру: код приходит человеку, а спросить его может только панель —
 * у скрипта, который её об этом просит, собеседника нет. Просьба помечена
 * номером захода, поэтому после неверного кода панель спросит снова, а на
 * ту же самую просьбу не переспросит.
 */
let asking = false;
const asked = new Map();
const askCode = async (a) => {
  if (asking || asked.get(a.id) === a.codeWait) return;
  const what = a.codeWait.replace(/\s*#\d+$/, '');
  const pass = !what.startsWith('код');
  asking = true;
  try {
    const v = prompt(`«${a.title}» — введи ${what}` + (pass ? ''
      : '\n\nTelegram присылает его в приложение на другом устройстве,\n' +
        'а если войти больше некуда — сообщением на номер.'), '');
    asked.set(a.id, a.codeWait);
    if (v === null || !v.trim()) return;
    const r = await post('/api/accounts/code',
      {account: a.id, code: pass ? '' : v, password: pass ? v : ''});
    if (!r.ok) alert(r.reason || 'не принято');
  } finally { asking = false; }
};

const accounts = async () => {
  try {
    const raw = await (await fetch('/api/accounts')).text();
    // перерисовываем только при изменениях: иначе список моргает каждые две секунды
    if (raw === accsRaw) return;
    const wasRole = new Map(accs.map(a => [a.id, a.role]));
    accsRaw = raw; accs = JSON.parse(raw);
    // ушёл в «только прогрев» (кнопкой, с другой вкладки или с сервера) —
    // снимаем галочки в составах. Иначе он так и стоял бы отмеченным, и при
    // запуске панель спросила бы «взять его в рассылку?» — одно «ОК», и
    // отдыхающий аккаунт снова пишет людям
    for (const a of accs) {
      // читатель (вкладка «Лиды») людям не пишет — из составов рассылки тоже долой
      if ((a.role === 'warm' || a.role === 'read') && wasRole.has(a.id) && wasRole.get(a.id) !== a.role) {
        for (const s of ['phones', 'chats']) if (crew[s]) crew[s].delete(a.id);
      }
    }
    paintAccounts();
    for (const a of accs) if (a.codeWait) askCode(a);
  } catch {}
};

/**
 * С каким списком получателей панель работает прямо сейчас.
 *
 * Раньше это была выпадашка посреди «Рассылки», и с нуля было не разобрать,
 * что к чему относится. Теперь список выбирает сама вкладка — но только в
 * момент запуска: открыть вкладку безопасно, идущий прогон от этого не
 * переключится (сервер и не даст — он откажет, пока прогон жив).
 */
/**
 * Какой набор показывают экраны «база», «результаты», «что напишем».
 * На прогон это больше не влияет: набор у каждого аккаунта свой, он
 * задаётся при запуске режима. Поэтому отказ (мешает ручная задача) —
 * не повод не запускать рассылку: quiet значит «молча, не беда».
 */
async function useSet(want, quiet) {
  if (lastState && lastState.baseSet === want) return true;
  const r = await post('/api/base-set', {set: want});
  if (!r.ok) { if (!quiet) alert(r.reason || 'не удалось переключить список получателей'); return false; }
  base(); state();
  return true;
}

function paintSetNow(s) {
  const runs = (s.auto || {}).runs || {};
  const p = $('#setnow-p'), c = $('#setnow-c');
  // Режимы независимы: отметь аккаунты здесь и запускай, даже если второй
  // режим уже работает. Один аккаунт — один режим.
  const line = (mine, other, word) => mine
    ? 'Состав можно менять на ходу.'
    : other ? `Идёт рассылка ${word} — здесь можно запустить свою на свободных аккаунтах.`
    : '';
  if (p) p.innerHTML = line(!!(runs.phones || {}).on, !!(runs.chats || {}).on, 'по чатам');
  if (c) c.innerHTML = line(!!(runs.chats || {}).on, !!(runs.phones || {}).on, 'по номерам');
}

// В каком профиле сидим. Рисуем один раз: имя профиля за жизнь вкладки
// не меняется — меняется только вместе со входом.
let whoamiDone = false;
function paintWhoami(s) {
  if (whoamiDone || !s.profile) return;
  whoamiDone = true;
  const box = $('#whoami');
  box.innerHTML = `<b>${esc(s.profile)}</b>` +
    (s.profileAdmin ? '<a href="/profiles">Профили</a>' : '') +
    '<a href="#" id="leave">Выйти в другой профиль</a>';
  box.hidden = false;
  $('#leave').onclick = async (e) => {
    e.preventDefault();
    await post('/api/logout', {});
    location.href = '/';
  };
}
/* ═══════════ СОСТОЯНИЕ — счётчики, прогресс, кто чем занят ═══════════ */


/* ═══════════ ВИДНО ЛИ, ЧТО ВКЛЮЧЕНО ═══════════ */
/**
 * Самый частый вопрос к панели: «почему ничего не происходит?». Ответ почти
 * всегда один — нужная штука просто выключена, или аккаунты на сегодня своё
 * отработали. Поэтому в каждой вкладке сверху одна полоса: горит — работает,
 * не горит — стоит, и рядом сказано почему.
 */
function runbar(id, on, title, why) {
  const el = $(id);
  if (!el) return;
  el.className = 'runbar' + (on ? ' on' : '');
  el.innerHTML = `<span class="lamp"></span><span>${title}</span>` +
    (why ? `<span class="why">${why}</span>` : '');
}

/** Чем заняты аккаунты прямо сейчас — без ухода на вкладку «Аккаунты». */
/**
 * Аккаунты этой вкладки: галочками выбираем, кого пустить в работу, и тут же
 * видно, чем каждый занят. Занятый другим режимом не выбирается — аккаунт
 * работает в одном наборе за раз, иначе он делил бы дневной предел надвое
 * и путал бы свои очереди.
 */
function paintAccRun(id, set) {
  const el = $(id);
  if (!el) return;
  // читатели (вкладка «Лиды») людям не пишут — в составах рассылки их нет
  const list = accs.filter((a) => accReady(a) && a.role !== 'read');
  if (!list.length) { el.innerHTML = ''; return; }
  const other = set === 'chats' ? 'phones' : 'chats';
  const run = (lastState && lastState.auto && lastState.auto.runs || {})[set] || {};
  const sel = crewOf(set);
  if (set === pickSet) work = sel;     // состав открытой вкладки — он же work
  /**
   * Состав и правда: галочки должны показывать то, что есть на сервере.
   * Кто работает в нашем режиме — тот отмечен (и остаётся отмеченным после
   * остановки, чтобы не набирать состав заново). Занятый соседним режимом
   * выбывает. А пока рассылка идёт, отмечены РОВНО её аккаунты: иначе
   * галочка стояла бы у того, кто на самом деле не работает.
   * crewBusy — пока сервер не ответил на нашу же правку, её не затираем.
   */
  if (!crewDirty[set]) {
    for (const a of list) {
      if (a.run === set) sel.add(a.id);
      else if (a.run) sel.delete(a.id);
      else if (run.on) sel.delete(a.id);
    }
  }
  const html = list.map((a) => {
    const w = a.warm || {};
    const onlyWarm = a.role === 'warm';
    const busy = !!a.busy;
    const elsewhere = a.run === other;
    const here = a.run === set;
    // «сейчас» панель считает на сервере: отдыхает до…, на сегодня всё,
    // ночь, ограничен, квота. Пусто — значит прогон не идёт
    const pickedOther = crewOf(other).has(a.id);   // уже отмечен в соседнем режиме
    const st = elsewhere ? `работает ${other === 'chats' ? 'по чатам' : 'по номерам'}`
      : pickedOther ? `выбран ${other === 'chats' ? 'по чатам' : 'по номерам'}`
      : busy ? esc(a.busy)
      : a.quarantine ? 'ограничен Telegram'
      : here ? (esc(a.now || '') || 'ждёт очереди')
      : sel.has(a.id) ? 'выбран — ждёт запуска'
      : onlyWarm ? 'только прогрев' : 'не выбран';
    const cnt = onlyWarm ? '—'
      : `сегодня ${a.sentToday || 0} из ${w.cap ?? '?'}`;
    // Не выбирается только занятый СОСЕДНИМ режимом: аккаунт работает в одном
    // наборе за раз. «Только прогрев» отмечать можно — панель переведёт его в
    // рассылку сама, когда будешь запускать (и спросит перед этим).
    const lock = elsewhere || pickedOther;
    return `<label class="r ${busy ? 'work' : ''} ${onlyWarm || lock ? 'off' : ''}">
      <input type="checkbox" data-pick="${a.id}" data-set="${set}"
             ${sel.has(a.id) && !pickedOther ? 'checked' : ''} ${lock ? 'disabled' : ''}>
      <span class="nm">${esc(a.name || a.title)}</span>
      <span class="cnt">${cnt}</span>
      ${onlyWarm ? '<span class="tag">только греется — возьмём в рассылку</span>' : ''}
      <span class="st">${st}</span></label>`;
  }).join('');
  if (el.dataset.html === html) return;     // не перерисовываем на каждый опрос
  el.dataset.html = html;
  el.innerHTML = html;
  el.querySelectorAll('[data-pick]').forEach((c) => { c.onchange = () => {
    const s = crew[c.dataset.set];
    const otherSet = c.dataset.set === 'chats' ? 'phones' : 'chats';
    if (c.checked) { s.add(c.dataset.pick); crewOf(otherSet).delete(c.dataset.pick); }
    else s.delete(c.dataset.pick);
    // Состояние режима берём свежее: обработчик живёт дольше, чем та
    // перерисовка, на которой его повесили, и запомненное в ней
    // «не запущено» давно устарело бы.
    const live = !!(((lastState && lastState.auto && lastState.auto.runs) || {})[set] || {}).on;
    if (live) crewDirty[set] = true;   // применит кнопка — до неё состав наш
    el.dataset.html = '';
    paintAccRun(id, set);
    paintAuto();
  }; });
}

/** Точка у вкладки в боковом меню, пока её функция работает. */
function navLamp(view, on) {
  const a = document.querySelector(`.nav-i[data-view="${view}"]`);
  if (!a) return;
  const has = a.querySelector('.lamp');
  if (on && !has) a.insertAdjacentHTML('beforeend', '<span class="lamp"></span>');
  if (!on && has) has.remove();
}

function paintRunState(s) {
  const auto = s.auto || {};
  // лампочка «Лиды» горит с любой вкладки, а не только пока она открыта
  if (s.enrich) navLamp('leads', !!(s.enrich.on || s.enrich.finding));
  const runs = auto.runs || {};
  // Каждая вкладка говорит только про СВОЙ режим: по номерам и по чатам
  // работают разные аккаунты и останавливаются они независимо.
  const bar = (el, set, word) => {
    const r = runs[set] || {};
    const n = (r.ids || []).length;
    runbar(el, !!r.on,
      r.on ? `<b>Рассылка ${word}${r.leadsOnly ? ' — только лидам' : ''} идёт</b>` : `<b>Рассылка ${word} выключена</b>`,
      r.on ? `${n} аккаунт(ов) · режим: ${
        r.mode === 'check' ? 'только проверка' : r.mode === 'write' ? 'только письма' : 'проверка и письма'}`
        : 'отметь аккаунты и нажми «Запустить»');
    navLamp(set === 'chats' ? 'chatsend' : 'send', !!r.on);
  };
  bar('#runbar-p', 'phones', 'по номерам');
  bar('#runbar-c', 'chats', 'по чатам');
  runbar('#runbar-w', !!s.warmup,
    s.warmup ? '<b>Прогрев работает</b>' : '<b>Прогрев выключен</b>',
    s.warmup ? 'ведёт все вошедшие аккаунты' : 'новые аккаунты не греются');

  paintAccRun('#accrun-p', 'phones');
  paintAccRun('#accrun-c', 'chats');
  navLamp('warmup', !!s.warmup);
}

const state = async () => {
  try {
    const s = await (await fetch('/api/state')).json();
    lastState = s;
    paintWhoami(s);
    baseLoading = !!s.baseLoading;
    paintSetNow(s);
    paintRunState(s);
    for (const k of ['base','checked','found','sent']) $('#n-'+k).textContent = s[k];
    $('#n-replies').textContent = s.replies ?? 0;
    // «занят» теперь про выбранный аккаунт: остальные могут работать параллельно
    const anyRun = s.running.length > 0;
    busy = !!accs.find(a => a.id === cur)?.busy;
    $('#status-t').textContent = anyRun ? (s.doing || s.running).join(' · ') : 'сейчас ничего не выполняется';
    const held = (s.claims || []).reduce((n, c) => n + c.n, 0);
    $('#claims').textContent = held ? `в работе у аккаунтов: ${held} номеров` : '';
    const px = s.proxy || [];
    const dead = px.filter(p => !p.ok);
    const downNow = new Set(dead.map(p => p.label));
    if ([...downNow].join('\n') !== [...proxyDownLabels].join('\n')) { proxyDownLabels = downNow; paintAccounts(); }
    const pst = $('#proxy-st');
    pst.textContent = dead.length
      ? `прокси лежит: ${dead[0].reason} — работа на паузе`
      : px.some(p => p.checked) ? `прокси в порядке${px.length === 1 && px[0].ip ? ` (IP ${px[0].ip})` : ''}` : '';
    pst.style.color = dead.length ? 'var(--no)' : 'var(--mut)';
    $('.run').classList.toggle('on', anyRun);
    // защита: задачи проверки/рассылки/сводки/чистки нужны живой сессии —
    // если выбранный аккаунт не вошёл, эти кнопки блокируем и объясняем почему
    const curAcc = accs.find(a => a.id === cur);
    const curReady = !!(curAcc && curAcc.session && curAcc.authed);
    // проверка/рассылка идут на выбранных (work) и живы, пока среди них есть
    // хоть один вошедший и не все заняты; сводка/чистка — по текущему аккаунту
    const workReady = accs.some(a => (work ? work.has(a.id) : true) && accReady(a));
    const workFree = accs.some(a => (work ? work.has(a.id) : true) && accReady(a) && !a.busy);
    document.querySelectorAll('button[data-t]').forEach(b => {
      const t = b.dataset.t;
      if (t === 'login') b.disabled = busy;
      else b.disabled = !workReady || !workFree;   // всё остальное — по отмеченным
    });
    // кнопки аккаунта гасим, только пока занят ИМЕННО он: на время ручного
    // действия прогон сам встаёт на паузу, остальные аккаунты трогать можно
    document.querySelectorAll('button[data-busy]').forEach(b => {
      const id = Object.values(b.dataset).find(v => accs.some(a => a.id === v));
      b.disabled = id ? !!accs.find(a => a.id === id)?.busy : false;
    });
    // плашка — только когда правда никто не вошёл: занятые в прогоне аккаунты не «невошедшие»
    $('#notready').hidden = accs.some(accReady) || !accs.length;
    $('#stop').disabled = !anyRun;
    paintTotal(s.total);
    $('#s4').classList.toggle('done', s.drafts > 0);
    parallelByDefault = !!s.profile && !s.profileAdmin;
    // расходы на прокси видны только в своих профилях, у клиента (основной) — нет
    const showTraffic = !!s.profile && !s.profileAdmin;
    if ($('#traffic-card') && $('#traffic-card').hidden === showTraffic) $('#traffic-card').hidden = !showTraffic;
    paintAuto(s.auto || {on: false, accounts: []});
  } catch { $('#status-t').textContent = 'сервер не отвечает'; }
};

/** Пока идёт вход, показываем текущий QR: файл переписывается сам, когда код протухает. */
/**
 * Текст рассылки. Загружаем один раз: перечитывать каждые две секунды нельзя —
 * затрёт то, что человек в этот момент печатает.
 */
let msgLoaded = false;
let noPhone = 0;          // сколько в очереди людей из чатов: у них нет даты звонка

/**
 * Как текст прочитает человек. Показываем оба случая, если получатели разные:
 * у человека из чата даты звонка не существует, и шаблон с {date} у него
 * превращается в «звонили .» — это видно только глазами, поэтому и показываем.
 */
// разворачивает {а|б|в} так же, как панель на сервере — для предпросмотра
const spin = (t) => {
  for (let i = 0; i < 100; i++) {
    const m = t.match(/\{([^{}]*)\}/);
    if (!m) break;
    let rep;
    if (m[1].includes('|')) { const o = m[1].split('|'); rep = o[Math.floor(Math.random()*o.length)]; }
    else rep = '\x00' + m[1] + '\x01';
    t = t.slice(0, m.index) + rep + t.slice(m.index + m[0].length);
  }
  return t.replaceAll('\x00','{').replaceAll('\x01','}');
};
const spinCount = (t) => {
  let n = 1; const re = /\{([^{}]*)\}/g; let m;
  while ((m = re.exec(t))) if (m[1].includes('|')) n *= m[1].split('|').length;
  return n;
};

const msgPreview = () => {
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
  const raw = $('#msg').value;
  // кастомные поля ({brand} и т.п.) в превью подставить нечем — человека тут нет.
  // Показываем читаемый плейсхолдер, иначе пугает «бренд не подставился», хотя
  // при реальной отправке он берётся из таблицы (extras.csv).
  const fill = (txt, name, day, nick) => spin(txt).replaceAll('{name}', name)
    .replaceAll('{date}', day).replaceAll('{username}', nick)
    .replaceAll('{brand}', '«их бренд»').replaceAll('{card}', '«их карточка»')
    .replaceAll('{lpr}', '«имя ЛПР»').trim();

  if (!raw.trim()) { $('#msg-prev').textContent = ''; $('#msg-warn').hidden = true; return; }
  const cnt = spinCount(raw);
  // три случайных варианта, как увидит человек из базы номеров
  let out = `непохожих писем: ${cnt}\n\nпримеры (как увидит человек):\n`;
  const seen = new Set();
  for (let k = 0; k < 12 && seen.size < 3; k++) seen.add(fill(raw, ', Евгения', date, '@evgenia'));
  out += [...seen].map(x => '· ' + x).join('\n');
  if (noPhone) out += `\n\nу человека из чата (без даты звонка):\n· ` + fill(raw, ', Сергей', '', '@sergey');
  $('#msg-prev').textContent = out;

  // подстановки, которых рассылка не знает: с пробелом, пустые, непарные скобки.
  // Такое письмо рассылка не отправит (draft-messages.py) — говорим сразу
  const odd = [...raw.matchAll(/\{([^{}|]*)\}/g)].map((m) => m[1])
    .filter((b) => !/^[\p{L}\w-]+$/u.test(b)).map((b) => `{${b}}`);
  if ((raw.match(/\{/g) || []).length !== (raw.match(/\}/g) || []).length) odd.push('непарная скобка');
  const dateHurts = noPhone && raw.includes('{date}');
  $('#msg-warn').hidden = !dateHurts && !odd.length;
  if (odd.length) {
    $('#msg-warn').innerHTML = `Непонятная подстановка: <b>${esc(odd.join(', '))}</b>. ` +
      'Имя пишется ровно <b>{name}</b> — без пробелов внутри скобок (при сохранении поправлю сам). ' +
      'С непонятной подстановкой письмо не уйдёт.';
  } else if (dateHurts) {
    $('#msg-warn').innerHTML = `В очереди <b>${noPhone}</b> человек без номера — они из чатов, ` +
      'и даты звонка у них нет. Подстановка <b>{date}</b> оставит у них пустое место. ' +
      'Убери <b>{date}</b> или заверни в вариант: <b>{ вы звонили {date}|здравствуйте}</b>.';
  }
};
/* ═══════════ ТЕКСТЫ ПИСЕМ, ЗЕРКАЛА, ГОЛОСОВОЕ ═══════════ */

const message = async () => {
  if (msgLoaded) return;
  try {
    const d = await (await fetch('/api/message')).json();
    $('#msg').value = (d.text || '').trim();
    // отдельный текст для собранных из чатов (может быть пустым)
    try { const dc = await (await fetch('/api/message?aud=chat')).json();
          if ($('#msg-chat')) $('#msg-chat').value = (dc.text || '').trim(); } catch {}
    // запасной текст для чатов — тем, у кого нет бренда
    try { const dp = await (await fetch('/api/message?aud=chat-plain')).json();
          if ($('#msg-plain')) $('#msg-plain').value = (dp.text || '').trim(); } catch {}
    msgLoaded = true;
    msgPreview();
  } catch {}
};

$('#msg-plain-save')?.addEventListener('click', async () => {
  const r = await post('/api/message?aud=chat-plain', {text: $('#msg-plain').value});
  const note = $('#msg-plain-note');
  if (!r.ok) { if (note) note.textContent = r.reason || 'не удалось сохранить'; return; }
  $('#msg-plain').value = r.text;
  if (note) note.textContent = 'сохранено в ' + new Date().toTimeString().slice(0, 5) +
    ((r.text || '').trim() ? '' : ' · пусто — людям без бренда не пишем');
});

$('#msg-chat-save')?.addEventListener('click', async () => {
  const r = await post('/api/message?aud=chat', {text: $('#msg-chat').value});
  const note = $('#msg-chat-note');
  if (!r.ok) { if (note) note.textContent = r.reason || 'не удалось сохранить'; return; }
  $('#msg-chat').value = r.text;
  // «пусто — уйдёт общий текст» пишем ТОЛЬКО когда текст и правда пустой,
  // иначе примечание вводило в заблуждение (текст есть, а написано «пусто»)
  if (note) note.textContent = 'сохранено в ' + new Date().toTimeString().slice(0, 5) +
    ((r.text || '').trim() ? '' : ' · пусто — этой аудитории уйдёт общий текст');
});
$('#msg').oninput = msgPreview;

/**
 * Сборный текст. Грузим один раз — как и остальные поля с текстом: перечитывать
 * каждые две секунды нельзя, затрёт то, что человек печатает прямо сейчас.
 */
/**
 * Зеркала-субдомены. Грузим один раз, дальше только показываем статус.
 * Токен в браузер не возвращается — панель его не отдаёт.
 */
let mirLoaded = false;
const mirror = async () => {
  try {
    const m = await (await fetch('/api/mirror')).json();
    document.querySelectorAll('#mir-base-lbl, #mir-base-lbl2').forEach(e => e.textContent = m.base);
    if (!mirLoaded) {
      $('#mir-on').checked = !!m.on;
      $('#mir-mode').value = m.mode;
      $('#mir-base').value = m.base;
      $('#mir-lo').value = m.every[0]; $('#mir-hi').value = m.every[1];
      mirLoaded = true;
    }
    const left = m.on && m.next ? Math.max(0, m.next - (m.sent - m.sinceCount)) : 0;
    $('#mir-note').innerHTML = !m.on ? 'выключено'
      : m.url ? `сейчас: <b>${esc(m.url)}</b> · сменится через ${left} писем · всего адресов ${m.pool}`
      : 'включаю…';
    $('#mir-api-box').open = $('#mir-api-box').open || m.mode === 'api' && !m.hasToken;
  } catch {}
};
const mirSave = async (extra) => {
  const lo = +$('#mir-lo').value || 30, hi = Math.max(lo, +$('#mir-hi').value || 50);
  const body = {
    on: $('#mir-on').checked, mode: $('#mir-mode').value,
    base: $('#mir-base').value.trim(), every: [lo, hi], ...extra,
  };
  const tok = $('#mir-token').value.trim();
  if (tok) body.token = tok;
  if ($('#mir-proj').value.trim()) body.projectId = $('#mir-proj').value.trim();
  if ($('#mir-team').value.trim()) body.teamId = $('#mir-team').value.trim();
  const r = await post('/api/mirror', body);
  $('#mir-token').value = '';             // введённый токен из поля убираем
  mirLoaded = false; mirror();
  return r;
};
$('#mir-save').onclick = () => mirSave();
$('#mir-on').onchange = () => mirSave();
$('#mir-new').onclick = async () => {
  $('#mir-note').textContent = 'меняю адрес…';
  const r = await mirSave({forceNew: true});
  if (r && r.url) $('#mir-note').innerHTML = `новый адрес: <b>${esc(r.url)}</b>`;
};
$('#mir-test').onclick = async () => {
  await mirSave();                        // сохранить токен перед проверкой
  $('#mir-note').textContent = 'спрашиваю Vercel…';
  const r = await post('/api/mirror/test', {});
  $('#mir-note').textContent = r.ok ? `✓ Vercel на связи, доменов в проекте: ${r.count}` : `✗ ${r.reason}`;
};

/** Второе письмо воронки: текст и сколько людей уже дошли до второго шага. */
let msg2Loaded = false;
const funnel = async () => {
  try {
    const f = await (await fetch('/api/funnel')).json();
    if (!msg2Loaded) {
      const d = await (await fetch('/api/message?second=1')).json();
      $('#msg2').value = (d.text || '').trim();
      msg2Loaded = true;
    }
    $('#funnel-note').textContent = f.hasText
      ? `написано первых писем: ${f.wrote} · вторых ушло: ${f.answered}`
      : 'текст пока не сохранён — без него второй шаг не включится';
  } catch {}
};
$('#msg2-save').onclick = async () => {
  const r = await post('/api/message?second=1', {text: $('#msg2').value});
  if (!r.ok) { alert(r.reason || 'не удалось сохранить'); return; }
  $('#msg2').value = r.text;
  funnel();
};
$('#msg-save').onclick = async () => {
  const r = await post('/api/message', {text: $('#msg').value});
  if (!r.ok) { alert(r.reason || 'не удалось сохранить'); return; }
  $('#msg').value = r.text;
  msgPreview();
  const t = new Date().toTimeString().slice(0, 5);
  $('#msg-note').innerHTML = `сохранено в ${t} · подстановки: <b>{name}</b> — имя, ` +
    '<b>{date}</b> — дата звонка, <b>{username}</b> — ник в Telegram';
};

/**
 * Голосовое. Грузим сведения один раз (как и текст) и обновляем после
 * загрузки/удаления — незачем дёргать сервер каждые две секунды.
 */
let voiceLoaded = false, hasVoice = false;
const fmtDur = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
const paintVoice = (v) => {
  hasVoice = !!v.exists;
  $('#voice-state').textContent = hasVoice
    ? `${v.name || 'голосовое'} · ${fmtDur(v.duration || 0)}` : 'не загружено';
  $('#voice-state').className = hasVoice ? 'on' : '';
  $('#voice-del').hidden = !hasVoice;
  $('#voice-play').hidden = !hasVoice;
  if (hasVoice) $('#voice-play').src = '/api/voice/file?t=' + Date.now();
  if (!hasVoice && $('#voicemode').checked) { $('#voicemode').checked = false; voiceModeChange(); }
  $('#voicemode').disabled = !hasVoice;
};
const voice = async () => {
  if (voiceLoaded) return;
  try { paintVoice(await (await fetch('/api/voice')).json()); voiceLoaded = true; } catch {}
};
$('#voice-pick').onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'audio/*,.ogg,.opus,.mp3,.m4a,.wav';
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    $('#voice-state').textContent = 'загружаю…';
    const res = await fetch('/api/voice', {
      method: 'POST',
      headers: {'x-filename': encodeURIComponent(inp.files[0].name), 'x-panel': '1'},
      body: inp.files[0],
    }).then(r => r.json()).catch(() => ({ok:false}));
    if (!res.ok) { alert(res.reason || 'не удалось загрузить'); voiceLoaded = false; voice(); return; }
    paintVoice({exists: true, name: res.name, duration: res.duration});
  };
  inp.click();
};
$('#voice-del').onclick = async () => {
  await post('/api/voice/delete', {});
  paintVoice({exists: false});
};
function voiceModeChange() {
  const on = $('#voicemode').checked;
  // голосовое и текст исключают друг друга: в голосовом режиме текстовая
  // отправка не при чём, поэтому её галочку убираем и блокируем
  if (on) { $('#send').checked = false; }
  $('#send').disabled = on;
  $('#sendwarn').hidden = !(on || $('#send').checked);
  $('#sendwarn').textContent = on
    ? 'Голосовое уйдёт людям по-настоящему и не отзывается. Начни с маленького «за раз».'
    : 'Сообщения уйдут людям по-настоящему и не отзываются. Начни с маленького «за раз».';
  $('#b-drafts').textContent = on ? 'Отправить голосовое'
    : $('#send').checked ? 'Написать и отправить' : 'Написать';
  paintAuto();
}
$('#voicemode').onchange = voiceModeChange;

let qrUrl = '';
const qr = async () => {
  // Спрашиваем картинку, только пока реально идёт вход. Иначе панель раз в две
  // секунды получала 404 и засыпала консоль ошибками, за которыми не видно
  // настоящих.
  const logging = accs.some(a => /вход/i.test(a.busy || ''));
  if (!logging) { if (!$('#qr').hidden) $('#qr').hidden = true; return; }
  if (!cur) return;
  try {
    const r = await fetch(`/api/qr?account=${encodeURIComponent(cur)}&t=${Date.now()}`);
    if (!r.ok) { $('#qr').hidden = true; return; }
    // прошлую картинку освобождаем: опрос идёт раз в две секунды,
    // иначе за час ожидания наберётся полторы тысячи мёртвых ссылок
    if (qrUrl) URL.revokeObjectURL(qrUrl);
    qrUrl = URL.createObjectURL(await r.blob());
    $('#qr-img').src = qrUrl;
    $('#qr').hidden = false;
  } catch { $('#qr').hidden = true; }
};

const tail = async () => {
  try {
    const d = await (await fetch('/api/log?from=' + logFrom)).json();
    if (d.lines.length) {
      $('#log').textContent += d.lines.join('\n') + '\n';
      $('#log').scrollTop = $('#log').scrollHeight;
      logFrom = d.total;
    }
  } catch {}
};

/** Вкладка «Результаты»: итоги по набору получателей, по дням и по аккаунтам. */
let resAt = 0;
/* ═══════════ РЕЗУЛЬТАТЫ — сводка, дни, ответы ═══════════ */

const resultsView = async (force) => {
  if (!force && Date.now() - resAt < 10_000) return;   // считать раз в 10 с достаточно
  resAt = Date.now();
  try {
    // вкладку открыли раньше, чем пришло состояние панели, — сначала узнаём,
    // по какому набору идёт рассылка, иначе показали бы «по номерам» по умолчанию
    if (!resSetTouched && !lastState) await state();
    if (!resSetTouched && lastState?.baseSet) $('#res-set').value = lastState.baseSet;
    const chats = $('#res-set').value === 'chats';
    const r = await (await fetch('/api/results?set=' + $('#res-set').value)).json();
    const t = r.totals || {};
    const n = (v) => nf(v || 0);
    const pct = (a, b) => (b ? ` (${Math.round((a || 0) / b * 100)}%)` : '');
    // у людей из чатов проверки номеров нет — показываем, сколько их собрано и сколько осталось
    $('#rs-checked').closest('.tile').querySelector('.tk').textContent = chats ? 'Людей из чатов' : 'Проверено номеров';
    $('#rs-checked').textContent = chats ? n(t.found) : n(t.checked);
    $('#rs-checked-sub').textContent = chats
      ? `осталось написать ${n(Math.max(0, (t.found || 0) - (t.sent || 0)))}`
      : `в Telegram ${n(t.found)} · давно не заходят ${n(t.idle)} · нет ${n(t.none)}`;
    $('#rs-sent').textContent = n(t.sent);
    $('#rs-sent-sub').textContent = `первых писем · пропущено неактивных ${n(t.skipped)}`;
    $('#rs-replied').textContent = n(t.replied) + pct(t.replied, t.sent);
    $('#rs-replied-sub').textContent = `да ${n(t.yes)} · нет ${n(t.no)} (🤝) · непонятно ${n(t.unclear)}`;
    $('#rs-second').textContent = n(t.second);
    $('#rs-second-sub').textContent = 'тем, кто ответил «да»';
    const cols = [...(chats ? [] : [['checked', 'проверено']]), ['sent', 'написали'], ['replied', 'ответили'],
                  ['yes', 'да'], ['no', 'нет'], ['unclear', 'непонятно'], ['second', 'ссылка']];
    const table = (rows, first, key) => rows.length
      ? `<tr><th>${first}</th>${cols.map(([, h]) => `<th>${h}</th>`).join('')}</tr>` +
        rows.map((x) => `<tr><td>${esc(x[key])}</td>${cols.map(([c]) => `<td>${x[c] || ''}</td>`).join('')}</tr>`).join('')
      : '<tr><td class="hint">пока пусто</td></tr>';
    $('#rs-days').innerHTML = table(r.days || [], 'день', 'day');
    $('#rs-accs').innerHTML = table(r.accounts || [], 'аккаунт', 'title');
    renderAnswers(r.answers || []);
  } catch {}
};
$('#res-set').onchange = () => { resSetTouched = true; resultsView(true); };

/*
 * Ответы — по аккаунтам, свёрнуто: список и так длинный. У человека раскрывается
 * вся переписка после его первого ответа (её читает «смотрит ответы», talks/<акк>.json);
 * тянем её только при раскрытии. Что раскрыто — помним между обновлениями вкладки.
 */
const ansOpen = new Set(), talkOpen = new Set(), talkCache = new Map();
let ansSig = '';
const ruPlural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many;
};
const talkTime = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg',
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const threadHtml = (msgs) => msgs.length
  ? msgs.map(([out, ts, text]) => `<div class="bub ${out ? 'out' : 'in'}">${esc(text)}<i>${out ? 'мы · ' : ''}${talkTime(ts)}</i></div>`).join('')
  : '<div class="hint">переписка подтянется при следующей проверке ответов (раз в полчаса)</div>';

async function loadTalk(el) {
  const id = el.dataset.acc + ' ' + el.dataset.key;
  const box = el.querySelector('.thread');
  if (talkCache.has(id)) box.innerHTML = threadHtml(talkCache.get(id));
  else box.innerHTML = '<div class="hint">загружаю…</div>';
  try {
    const d = await (await fetch(`/api/talk?acc=${encodeURIComponent(el.dataset.acc)}&key=${encodeURIComponent(el.dataset.key)}`)).json();
    talkCache.set(id, d.msgs || []);
    box.innerHTML = threadHtml(d.msgs || []);
  } catch { if (!talkCache.has(id)) box.innerHTML = '<div class="hint">не загрузилось</div>'; }
}

function renderAnswers(ans) {
  const sig = JSON.stringify(ans);
  if (sig === ansSig) return;          // ничего нового — не перерисовываем: раскрытое не схлопнется
  ansSig = sig;
  const box = $('#rs-answers');
  if (!ans.length) { box.innerHTML = '<div class="hint">пока нет</div>'; return; }
  const byAcc = new Map();
  for (const x of ans) {
    if (!byAcc.has(x.accountId)) byAcc.set(x.accountId, []);
    byAcc.get(x.accountId).push(x);
  }
  box.innerHTML = [...byAcc].map(([acc, list]) => {
    const yes = list.filter((x) => x.verdict === 'yes').length;
    return `<details class="ans-acc" data-acc="${esc(acc)}"${ansOpen.has(acc) ? ' open' : ''}>
      <summary><b>${esc(list[0].account)}</b><span class="ans-sum">${list.length} ${ruPlural(list.length, 'ответ', 'ответа', 'ответов')}` +
      `${yes ? ` · <span class="ans-yes">да ${yes}</span>` : ''}${list.length - yes ? ` · непонятно ${list.length - yes}` : ''} · последний ${esc(list[0].at)}</span></summary>` +
      list.map((x) => {
        const id = acc + ' ' + x.who;
        return `<details class="ans-p" data-acc="${esc(acc)}" data-key="${esc(x.who)}"${talkOpen.has(id) ? ' open' : ''}>
          <summary><span class="ans-when">${esc(x.at)}</span><span class="ans-who">${esc(x.who)}</span>
            <span class="${x.verdict === 'yes' ? 'ans-yes' : 'ans-unc'}">${x.verdict === 'yes' ? 'да' + (x.link ? ' · ссылка ушла' : '') : 'непонятно'}</span>
            <span class="ans-first">${esc(x.text || '—')}</span>
            ${x.more ? `<span class="ans-more" title="сообщений после первого ответа">+${x.more}</span>` : ''}
            <button class="ghost mini" data-ans-acc="${esc(acc)}" title="Открыть этот аккаунт в Telegram Desktop на своём компьютере и ответить человеку">Ответить</button></summary>
          <div class="thread">${talkOpen.has(id) && talkCache.has(id) ? threadHtml(talkCache.get(id)) : ''}</div></details>`;
      }).join('') + '</details>';
  }).join('');
  // раскрытые до перерисовки — подтянуть свежую переписку
  box.querySelectorAll('.ans-p[open]').forEach(loadTalk);
}

// toggle не всплывает — ловим на погружении
$('#rs-answers').addEventListener('toggle', (e) => {
  const el = e.target;
  if (el.classList.contains('ans-acc')) {
    if (el.open) ansOpen.add(el.dataset.acc); else ansOpen.delete(el.dataset.acc);
  } else if (el.classList.contains('ans-p')) {
    const id = el.dataset.acc + ' ' + el.dataset.key;
    if (el.open) { talkOpen.add(id); loadTalk(el); } else talkOpen.delete(id);
  }
}, true);
// «Ответить» — тот же комплект «На ПК», что в списке аккаунтов: панель на сервере, писать — со своего компьютера
$('#rs-answers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ans-acc]');
  if (!b) return;
  e.preventDefault();                  // кнопка в заголовке — раскрывать не надо
  openKit(b.dataset.ansAcc);
});
let resSetTouched = false;   // пока не выбрали руками — показываем тот набор, по которому идёт рассылка

/** Лента событий — что произошло, человеческим языком, свежие сверху. */
let eventsSeen = '';
const eventsFeed = async () => {
  try {
    const list = await (await fetch('/api/events?n=100')).json();
    const key = list.length ? list[0].t + ':' + list.length : '';
    if (key === eventsSeen) return;
    eventsSeen = key;
    $('#events').innerHTML = list.length ? list.map((e) => `<div class="ev${
        /⚠|⏳|■/.test(e.icon) ? ' ev-warn' : ''}">
      <span class="ev-t">${esc(e.time)}</span><span>${esc(e.icon)}</span>
      <span class="ev-who">${esc(e.who || 'панель')}</span><span>${esc(e.text)}</span></div>`).join('')
      : '<span class="ev-empty">пока тихо</span>';
  } catch {}
};

/** Кто ответил — списком, чтобы не лезть в журнал. */
// итог ответов — из тех же файлов, что и вкладка «Результаты», по текущему набору.
// Старая сводка (/api/replies) обновлялась только по кнопке и врала «никто не ответил»
let repliesAt = 0;
const repliesList = async () => {
  if (Date.now() - repliesAt < 15_000) return;
  repliesAt = Date.now();
  try {
    const r = await (await fetch('/api/results?set=' + (lastState?.baseSet || 'phones'))).json();
    const t = r.totals || {};
    $('#replies').innerHTML = t.replied
      ? `<div style="margin-top:10px"><b>Ответили ${t.replied}</b> из ${t.sent || 0}: ` +
        `да ${t.yes || 0} · нет ${t.no || 0} · непонятно ${t.unclear || 0} · ` +
        `вторых писем ушло ${t.second || 0}. Подробно — во вкладке «Результаты».</div>`
      : `<div style="color:var(--mut);margin-top:8px">${t.sent ? `написано ${t.sent}, пока никто не ответил` : 'писем ещё не было'}</div>`;
    // когда автопрогон последний раз заглядывал в диалоги — иначе «никто не ответил» нельзя отличить от «не проверяли»
    const ca = lastState?.repliesCheckedAt;
    $('#replies').insertAdjacentHTML('beforeend', `<div style="color:var(--mut);margin-top:4px;font-size:12px">${ca
      ? `ответы проверены в ${new Date(ca).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` +
        ` · за час проверено аккаунтов: ${lastState.repliesChecksHour || 0}`
      : 'ответы ещё ни разу не проверялись автопрогоном'}</div>`);
  } catch {}
};

const found = async () => {
  if (!$('#rows')) return;   // список найденных больше не выводим вживую — только файлом
  const rows = await (await fetch('/api/found')).json();
  $('#rows').innerHTML = rows.map(r => `<tr>
    <td class="numcell">${r.phone}</td><td>${r.name || '—'}</td>
    <td style="color:var(--mut)">${(r.last_call||'').slice(0,10)}</td>
    <td>${r.sent ? '<span class="badge yes">отправлено</span>'
        : r.draft ? '<span class="badge wait">черновик</span>' : ''}</td></tr>`).join('')
    || '<tr><td colspan="4" style="color:var(--mut)">пока пусто — нажми «Проверить базу»</td></tr>';
};

/**
 * Сводка за всё время. Числа в кружках наверху — про то, что лежит в файлах
 * сейчас; чистка их обнуляет. Эта строка считает вместе с кешем и потому
 * чистку переживает — показываем её только когда есть что показать сверх
 * текущего, иначе она просто дублировала бы кружки.
 */
const nfmt = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
function paintTotal(t) {
  const box = $('#alltime');
  if (!t || !t.wipes) { box.hidden = true; return; }
  box.hidden = false;
  const when = t.since ? new Date(t.since).toLocaleDateString('ru-RU') : '';
  const last = t.last
    ? `последняя чистка ${new Date(t.last.at).toLocaleString('ru-RU')}` +
      (t.last.backup ? ` · данные в <b>${esc(t.last.backup)}</b>` : '')
    : '';
  box.innerHTML = `За всё время${when ? `, с ${when}` : ''}:
    проверено <b>${nfmt(t.checked)}</b> ·
    есть в Telegram <b>${nfmt(t.found)}</b> ·
    написано <b>${nfmt(t.drafts)}</b> ·
    отправлено <b>${nfmt(t.sent)}</b>` + (last ? `<br>${last}` : '');
}

/**
 * Автопрогон. Кого гонять — отмечается галочками; пока прогон идёт, вместо
 * галочек показываем, чем каждый занят и до какого времени отдыхает.
 * Всё остальное (размер пачки, паузы, текст, «отправлять сразу») берём из
 * шагов 3 и 4 — второго набора тех же полей быть не должно.
 */
let lastState = null, baseLoading = false;
let work = null, autoOn = false, autoLast = {on: false, accounts: []}, autoRaw = '';
/**
 * Кого запускаем — отдельно по номерам и отдельно по чатам. Выбор живёт на
 * самих вкладках рассылки: там же видно, кто свободен, а кто уже работает в
 * другом режиме. Экран «Аккаунты» теперь только показывает, ничего не выбирает.
 */
const crew = {phones: null, chats: null};
let pickSet = 'phones';
// Состав тронули, но ещё не применили: пока так, галочки не подгоняем под
// сервер — иначе снятая вернулась бы обратно на ближайшей перерисовке.
const crewDirty = {phones: false, chats: false};
/** Можно ли вообще брать этот аккаунт в рассылку. */
const canPick = (a) => accReady(a) && a.role !== 'warm' && a.role !== 'read';
/** Чем отмеченный состав отличается от того, что работает прямо сейчас. */
function crewDiff(set, run) {
  const sel = crew[set] || new Set();
  const cur = new Set(run.ids || []);
  // прогревной тоже считается: при запуске панель переведёт его в рассылку
  const free = (id) => { const a = accs.find(x => x.id === id); return a && accReady(a) && a.role !== 'read' && (!a.run || a.run === set); };
  return {
    add: [...sel].filter(id => !cur.has(id) && free(id)),
    drop: [...cur].filter(id => !sel.has(id)),
  };
}

/**
 * Состав вкладки. По умолчанию — все, кто может писать и ничем не занят, но
 * придумать его можно только когда аккаунты уже загрузились: на пустом списке
 * получился бы пустой состав, и вкладка навсегда осталась бы без галочек.
 */
function crewOf(set) {
  if (!crew[set] && accs.length) {
    crew[set] = new Set(accs.filter(a => canPick(a) && !a.run).map(a => a.id));
  }
  return crew[set] || new Set();
}
/** Выбор текущей вкладки: он же work — по нему идут и запуск, и ручные заходы. */
function useWork(set) { pickSet = set; work = crewOf(set); }
const fmtWait = (s) => s >= 3600 ? `${Math.floor(s / 3600)} ч ${Math.round(s % 3600 / 60)} мин`
  : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * Форма запуска после обновления страницы — с теми настройками, с которыми
 * запускали в последний раз (а пока прогон идёт — это его настоящие). Раньше
 * галочки «второй шаг» и «по очереди» возвращались к умолчанию, и казалось,
 * что идущий прогон работает без них.
 */
let formRestored = false;
let csParallelRestored = false;
// ⚡ параллель стоит сразу во всех профилях, кроме основного: основной —
// профиль клиента, у него как было (пусто). Без привратника — тоже как было.
let parallelByDefault = false;
// Снимки формы по режимам (auto-last.json пишет их по каждому) и признак
// «человек что-то поправил, но ещё не запускал».
let formBySet = { phones: null, chats: null };
let formTouched = false;
let formShownSet = '';
// Поля запуска: правка в любом из них — это «в форме есть несохранённое».
const FORM_FIELDS = ['#amode', '#apause', '#delay', '#ddelay', '#ddelaymax', '#dhold', '#dholdmax',
                     '#limit', '#dlimit', '#rotate', '#rotwait', '#warmon', '#funnel', '#cs-funnel',
                     '#cs-ddelay', '#cs-ddelaymax', '#sm-send', '#sm-draft', '#checkcap', '#daycap'];

function applyForm(f, forceSend = false) {
  if (!f) return;
  const val = (id, v) => { if ($(id) && v !== undefined && v !== null && v !== '') $(id).value = v; };
  const chk = (id, v) => { if ($(id) && v !== undefined) $(id).checked = !!v; };
  val('#amode', f.mode);
  // режим по умолчанию — ВСЕГДА «отправка»; черновик стал отладочным и не
  // залипает между запусками (раньше восстанавливался draft и уходило вхолостую).
  // Но при переходе между вкладками выбор «отправлять/черновик» не трогаем:
  // человек его только что видел и помнит, а подмена на ровном месте пугает.
  if (forceSend) { chk('#sm-send', true); chk('#sm-draft', false); sendModeChange(); }
  // «Второй шаг» у каждого режима СВОЙ (#funnel — номера, #cs-funnel — чаты),
  // поэтому берём его из снимка своего режима, а не из того, что сейчас
  // подставляем: иначе переход на вкладку чатов переписывал бы галочку номерам
  // (и наоборот), и следующий запуск унаследовал бы чужой второй шаг.
  if (formBySet.phones) chk('#funnel', formBySet.phones.funnel);
  if (formBySet.chats) chk('#cs-funnel', formBySet.chats.funnel);
  chk('#warmon', f.warm !== false);
  if (!$('#rotate').value.trim()) val('#rotate', f.rotate);
  val('#rotwait', f.rotateWait);
  if (f.pause) val('#apause', Math.round(f.pause / 60));
  val('#limit', f.checkLimit); val('#delay', f.checkDelay);
  val('#dlimit', f.writeLimit); val('#ddelay', f.writeDelay); val('#ddelaymax', f.writeDelayMax);
  val('#dhold', f.hold); val('#dholdmax', f.holdMax);
  formTouched = false;                 // в полях теперь ровно снимок
}

function restoreForm(f) {              // первый показ после загрузки страницы
  if (formRestored || !f) return;
  formRestored = true;
  applyForm(f, true);
}

/**
 * Настройки запуска — одни поля на обе вкладки, но у каждой вкладки СВОЙ
 * последний запуск (auto-last.json по режимам). Раньше форма восстанавливалась
 * один раз и только из базового набора: открыл вкладку чатов после номеров — и
 * «Запустить по чатам» молча отправляло чужие лимиты, паузы и режим, а свои
 * настройки чатов не показывались нигде. Теперь при переходе на вкладку
 * подставляем снимок этой вкладки. Если человек уже что-то поправил и не
 * запускал — не затираем: его правка важнее снимка.
 */
function restoreFormFor(set) {
  const f = formBySet[set];
  if (!f || formShownSet === set) return;
  if (formTouched && formShownSet) return;
  formShownSet = set;
  applyForm(f);
}

function paintAuto(a) {
  autoLast = a = a || autoLast;
  const runs = a.runs || {};
  // снимки формы по режимам: из них подставляем настройки при переходе на вкладку
  formBySet = { phones: (runs.phones || {}).form || null, chats: (runs.chats || {}).form || null };
  restoreForm(a.form);
  if (formRestored && !formShownSet) formShownSet = a.set || 'phones';
  const on = autoOn = !!a.on;
  const onP = !!(runs.phones || {}).on, onC = !!(runs.chats || {}).on;
  // у каждого режима свой второй шаг: его ставит applyForm из снимка СВОЕГО
  // режима (restoreForm/restoreFormFor), отдельного восстановления не нужно

  // «Параллельно» — одно значение на обе вкладки: как запущен идущий прогон;
  // не идёт — в своих профилях включено, у клиента — как запускал в прошлый раз
  if (!csParallelRestored) {
    csParallelRestored = true;
    const was = (r) => r && r.form ? !!r.form.parallel || r.form.serial === false : false;
    const c = runs.chats || {}, ph = runs.phones || {};
    const live = c.on ? c : ph.on ? ph : null;
    const par = live && live.form ? was(live) : parallelByDefault ? true : (was(c) || was(ph));
    $('#cs-parallel').checked = $('#p-parallel').checked = par;
  }
  $('#cs-funnel').disabled = onC;
  // кнопка каждой вкладки живёт своей жизнью: выбор — её галочки, а блокировка
  // — её собственный режим
  const ready = (set) => accs.filter(x => crew[set] && crew[set].has(x.id) && accReady(x) && x.role !== 'read' && !x.run);

  // Строки «кто чем занят» — у каждой вкладки СВОИ: показываем только те
  // аккаунты, что работают в её режиме. Проверок бывает больше лимита — это
  // сделанное до его введения, не превышение.
  const rows = (el, set, live) => {
    if (!el) return;
    const mine = live ? (a.accounts || []).filter(x => x.set === set) : [];
    el.innerHTML = mine.map(x => `<div class="arow">
      <b title="${esc(x.phone || '')}">${esc(x.title)}</b>
      <span style="color:${x.stopped ? 'var(--no)' : x.working ? 'var(--ok)' : 'var(--mut)'}">${esc(x.status || '')}</span>
      <span class="w">${set !== 'chats' && x.checks ? `проверено сегодня ${x.checks.today} (лимит ${x.checks.cap}) · ` : ''}${
        `написано сегодня ${x.today ?? 0} из ${x.cap ?? '—'}`}</span>
    </div>`).join('');
  };
  rows($('#autostate'), 'phones', onP);
  rows($('#cs-state'), 'chats', onC);

  /**
   * Кнопка режима делает ровно то, что сейчас имеет смысл:
   * не работает — «Запустить»; работает и состав поменяли галочками —
   * «Добавить в работу» (встроит новых в идущий поток, лишних выведет);
   * работает и состав тот же — «Остановить».
   */
  const btn = (el, set, live, word) => {
    if (!el) return [];
    const chosen = ready(set);
    const d = crewDiff(set, runs[set] || {});
    if (live && (d.add.length || d.drop.length)) {
      el.textContent = d.add.length && !d.drop.length ? `Добавить в работу: ${d.add.length}`
        : d.drop.length && !d.add.length ? `Снять с работы: ${d.drop.length}`
        : `Применить состав: +${d.add.length} / −${d.drop.length}`;
      el.className = 'primary big';
      el.disabled = false;
    } else {
      el.textContent = live ? 'Остановить' : word;
      el.className = live ? 'danger big' : 'primary big';
      el.disabled = !chosen.length && !live;
    }
    if (!live) {
      // Прокси лежит у ВСЕХ выбранных — сервер такой запуск примет, но тик молча
      // выйдет, и это выглядит как «запустилось и ничего не происходит». Не даём
      // нажать и говорим, чего ждём: строку про прокси видно в шапке.
      const dead = chosen.length > 0 && chosen.every((a) => proxyDownLabels.has(a.proxyLabel));
      if (dead) {
        el.disabled = true;
        el.title = 'Прокси этих аккаунтов не отвечает — запуск ничего не сделает, ждём подъёма';
      } else el.title = '';
    }
    return chosen;
  };
  btn($('#b-auto'), 'phones', onP, 'Запустить');
  const csChosen = btn($('#cs-auto'), 'chats', onC, 'Запустить по чатам') || [];
  const note = $('#cs-note');
  if (note) note.textContent = onC
    ? `работают: ${(runs.chats.ids || []).map(id => {
        const x = accs.find(y => y.id === id); return x ? (x.name || x.title) : id; }).join(', ')}`
    : csChosen.length ? `запустим: ${csChosen.map(x => x.name || x.title).join(', ')}`
    : 'отметь аккаунты в списке выше';
  // настройки запуска общие на оба режима — запираем их, пока работает любой.
  // #warmon и #funnel тоже здесь: они уходят в /api/auto при запуске, и раньше
  // их можно было переключить на ходу — снятая «беречь новые аккаунты» на одной
  // вкладке выключала отлёжку и у второго, уже идущего прогона.
  for (const id of ['#amode','#apause','#delay','#ddelay','#ddelaymax','#dhold',
                    '#dholdmax','#limit','#dlimit','#warmon','#funnel',
                    '#sm-draft','#sm-send','#rotate','#rotwait','#p-parallel','#cs-parallel'])
    if ($(id)) $(id).disabled = on;
  if (!on && $('#rotate').value.trim()) $('#p-parallel').disabled = true;
  // правку в форме запоминаем: переход на другую вкладку не должен затирать
  // то, что человек поменял и ещё не запустил
  for (const id of FORM_FIELDS) {
    const el = $(id);
    if (el && !el.dataset.formWatch) {
      el.dataset.formWatch = '1';
      // чья правка: форма общая на обе вкладки рассылки — запоминаем, с какой правили
      const mark = () => {
        formTouched = true;
        const v = activeView();
        if (v === 'chatsend') formShownSet = 'chats';
        else if (v === 'send') formShownSet = 'phones';
      };
      el.addEventListener('input', mark);
      el.addEventListener('change', mark);
    }
  }

  // предупреждение об отправке: пока идёт — по тому, что прогон делает НА САМОМ ДЕЛЕ
  const asVoice = on ? a.voice : $('#voicemode').checked;
  const asSend = on ? a.send : ($('#send').checked && $('#amode').value !== 'check');
  $('#autowarn').hidden = !(asVoice || asSend);
  $('#autowarn').innerHTML = asVoice
    ? 'Голосовые уходят людям <b>по-настоящему</b> и не отзываются.'
    : 'Сообщения уйдут людям <b>по-настоящему</b>. Отозвать нельзя — поставь дневной предел.';

  paintStage($('#stage'), 'phones', runs.phones || {}, a);
  paintStage($('#cs-stage'), 'chats', runs.chats || {}, a);
}

/**
 * Крупная строка «что происходит прямо сейчас». Ради неё всё и затевалось:
 * журнал читать никто не будет, а понять этап нужно с одного взгляда.
 */
/**
 * Полоса «что сейчас происходит» — своя у каждой вкладки: её режим, её
 * аккаунты, её числа по базе. Раньше была одна на панель и показывала чужое.
 */
function paintStage(box, set, run, a) {
  if (!box) return;
  const s = lastState || {};
  const n = (s.bySet || {})[set] || {};
  const chats = set === 'chats';
  if (baseLoading && !chats) {
    box.hidden = false;
    box.innerHTML = '<b>Разбираю таблицу…</b><br><span style="color:var(--mut)">' +
      'ищу колонку с номерами</span>';
    return;
  }
  if (!run.on) {
    // режим не идёт — показываем итог прошлого, если что-то уже сделано
    if (!n.checked && !n.drafts) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<b>Сейчас не работает.</b><br><span style="color:var(--mut)">' +
      (chats ? `Написано ${n.sent ?? 0} из ${n.found ?? 0}. `
             : `Проверено ${n.checked} из ${n.base}, найдено ${n.found}, написано ${n.drafts}. `) +
      'Нажми «Запустить», чтобы продолжить.</span>';
    return;
  }
  const st = (a.accounts || []).filter(x => x.set === set).map(x => x.status || '');
  const has = (w) => st.some(x => x.startsWith(w));
  let head;
  if (a.hold > 0 && a.rotate) head = `Меняю IP на прокси — ещё ${a.hold} с`;
  else if (has('пишет людям')) head = 'Пишу людям';
  else if (has('проверяет номера')) head = 'Проверяю номера';
  else if (has('смотрит, кто ответил')) head = 'Смотрю, кто ответил';
  else if (has('пауза — ты')) head = 'Пауза — ты работаешь с аккаунтами';
  else if (st.length && st.every(x => /на сегодня всё|догревается|ограничен/.test(x))) head = 'Рассылка на сегодня всё — аккаунты догреваются, продолжим завтра';
  else if (has('ночь')) head = 'Ночь — письма ждут утра';
  else head = 'Пауза между заходами';
  const pct = n.base ? Math.round((n.checked / n.base) * 100) : 0;
  const sendWord = (run.voice ? 'голосовым, уходит сразу'
                 : run.send ? 'ОТПРАВЛЯЮ по-настоящему' : 'только черновики, никому не уходит')
                 + (a.serial ? (a.rotate ? ' · по очереди, со сменой IP' : ' · по очереди') : '');
  box.hidden = false;
  box.innerHTML =
    `<b>${head}</b> · режим: ${esc(sendWord)}<br>` +
    `<span style="color:var(--mut)">${chats
      ? `по чатам: людей ${n.found} · написано ${n.sent} · осталось ${Math.max(0, (n.found || 0) - (n.sent || 0))}`
      : `по номерам: проверено ${n.checked} из ${n.base} · найдено ${n.found} · написано ${n.sent}`}` +
    `${n.replies ? ` · ответили ${n.replies}` : ''}` +
    `</span><div class="bar"><i style="width:${chats ? (n.found ? Math.round(n.sent / n.found * 100) : 0) : pct}%"></i></div>`;
}

/**
 * Отмеченные «только прогрев» — переводим в рассылку перед работой.
 * Роль не переключается молча: у аккаунта может быть не дописан прогрев,
 * и это надо показать словами, а не графиком.
 */
async function takeWarmIntoRun(set) {
  const picked = [...(crew[set] || [])].map(id => accs.find(a => a.id === id)).filter(Boolean);
  // на отдыхе после заморозки — в рассылку не берём и не спрашиваем: сервер всё
  // равно откажет, а вопрос «взять?» подталкивает нажать «ОК»
  for (const a of picked) if ((a.holdUntil || a.restUntil) && crew[set]) crew[set].delete(a.id);
  const warm = picked.filter(a => !a.holdUntil && !a.restUntil && accReady(a) && a.role === 'warm');
  if (!warm.length) return true;
  const lines = warm.map(a => {
    const w = a.warm || {};
    return `• ${a.name || a.title} — ${w.note || 'на прогреве'}` +
           (w.resting ? ' (ещё отлёживается)' : ` · сегодня может ${w.left ?? w.cap ?? '?'}`);
  }).join('\n');
  if (!confirm(`Эти аккаунты сейчас только греются:\n\n${lines}\n\n` +
      'Взять их в рассылку? Писать они будут по графику прогрева — не больше своего ' +
      'дневного предела, а те, что на отлёжке, начнут, когда она кончится.')) return false;
  for (const a of warm) await post('/api/accounts/role', {id: a.id, role: 'send', set});
  await loop();
  return true;
}

async function startAuto(set, extra = {}) {
  const run = ((lastState && lastState.auto && lastState.auto.runs) || {})[set] || {};
  if (run.on) {
    // состав поменяли галочками — встраиваем новых в идущий поток, а снятых
    // выводим; рассылка при этом не останавливается
    const d = crewDiff(set, run);
    if (d.add.length || d.drop.length) {
      if (!await takeWarmIntoRun(set)) return;
      const r = await post('/api/auto/crew', {set, ids: [...crew[set]]});
      if (!r.ok && r.reason) alert(r.reason);
      crewDirty[set] = false;
      state();
      return;
    }
    // состав тот же — значит нажали «Остановить». Гасим только свой режим
    await post('/api/auto', {on: false, set});
    crewDirty[set] = false;
    state();
    return;
  }
  crewDirty[set] = false;
  useWork(set);
  if (!await takeWarmIntoRun(set)) return;
  await useSet(set, true);          // экраны переводим на этот набор, если можно
  const mode = $('#amode').value;
  const voice = mode !== 'check' && $('#voicemode').checked;
  const send = mode !== 'check' && !voice && $('#send').checked;
  const who = accs.filter(x => work.has(x.id) && accReady(x) && x.role !== 'read').map(x => x.title);
  if (!who.length) {
    alert(extra.leads ? 'Отметь писателей на вкладке «Рассылка по чатам» — лидам пишут они, с теми же текстами и паузами'
      : 'Отметь хотя бы один вошедший аккаунт');
    return;
  }
  const cap = Math.max(1, parseInt($('#daycap').value) || 15);
  const wantFunnel = set === 'chats' ? $('#cs-funnel').checked : $('#funnel').checked;
  if (wantFunnel && !$('#msg2').value.trim()) {
    alert('Второй шаг включён, но текст второго письма пуст.\n\nНапиши его в шаге «Что напишем» и сохрани.');
    return;
  }
  if ((send || voice) && !confirm(
      `Запустить ${extra.leads ? 'рассылку ЛИДАМ' : 'автопрогон'} от: ${who.join(', ')}?\n\n` +
      `Панель будет САМА ${voice ? 'отправлять голосовые' : 'отправлять сообщения'} людям, ` +
      `пачка за пачкой, пока база не кончится.\n` +
      `Не больше ${cap} в сутки на аккаунт (новые — меньше, по графику разгона).\n` +
      `\nОтозвать отправленное нельзя. Продолжить?`)) return;
  const r = await post(extra.leads ? '/api/enrich/write' : '/api/auto', {
    on: true, set, mode, send, voice, warm: $('#warmon').checked, leadsOnly: !!extra.leads,
    funnel: set === 'chats' ? $('#cs-funnel').checked : $('#funnel').checked,
    // параллель (все сразу) — у каждой вкладки своя галочка; на одном IP сервер предупредит
    serial: !$(set === 'chats' ? '#cs-parallel' : '#p-parallel').checked,
    rotate: $('#rotate').value.trim(),
    parallel: $(set === 'chats' ? '#cs-parallel' : '#p-parallel').checked,
    rotateWait: +$('#rotwait').value || 10,
    accounts: [...work].filter(id => { const a = accs.find(x => x.id === id) || {}; return accReady(a) && a.role !== 'read'; }),
    pause: (+$('#apause').value || 40) * 60,     // поле в минутах, серверу — секунды
    checkLimit: $('#limit').value, checkDelay: $('#delay').value,
    writeLimit: $('#dlimit').value, writeDelay: $('#ddelay').value,
    writeDelayMax: $('#ddelaymax').value, hold: $('#dhold').value, holdMax: $('#dholdmax').value,
  });
  if (!r.ok && r.reason) alert(r.reason);
  // запустились — значит в полях ровно снимок этого запуска: правок «на будущее»
  // в форме больше нет, и переход на другую вкладку снова может показать её снимок
  if (r.ok) { formTouched = false; formShownSet = set; }
  state();
}
/* ═══════════ ЗАПУСК РАССЫЛКИ ═══════════ */


$('#b-auto').onclick = () => startAuto('phones');
// вкладка «по чатам»: тот же запуск, только список получателей свой
if ($('#cs-auto')) $('#cs-auto').onclick = () => startAuto('chats');
// «Как слать» (вкладка чатов): пауза между сообщениями — зеркало общих полей
// («настройки общие на обе рассылки»), чтобы менять скорость прямо тут.
const syncCsDelay = () => {
  if ($('#cs-ddelay') && $('#ddelay')) $('#cs-ddelay').value = $('#ddelay').value || 180;
  if ($('#cs-ddelaymax') && $('#ddelaymax')) $('#cs-ddelaymax').value = $('#ddelaymax').value || 350;
};
syncCsDelay();
$('#ddelay')?.addEventListener('change', syncCsDelay);
$('#ddelaymax')?.addEventListener('change', syncCsDelay);
$('#cs-ddelay')?.addEventListener('change', () => { if ($('#ddelay')) $('#ddelay').value = $('#cs-ddelay').value; });
$('#cs-ddelaymax')?.addEventListener('change', () => { if ($('#ddelaymax')) $('#ddelaymax').value = $('#cs-ddelaymax').value; });
$('#amode').onchange = () => paintAuto();

/**
 * Мобильный прокси со сменой IP. Ссылку лучше проверить до запуска: иначе
 * о том, что она неверная, узнаешь в середине прогона.
 */
// один прокси на всех — ставим его всем аккаунтам разом, а не по одному
$('#b-bioall').onclick = async () => {
  const list = accs.filter(a => a.session);
  if (!list.length) { alert('Нет вошедших аккаунтов'); return; }
  const about = prompt(`Описание «о себе» — поставится ВСЕМ ${list.length} вошедшим аккаунтам.\n\nВведи текст (до 70 символов):`, '');
  if (about === null) return;
  if (!confirm(`Поставить это описание всем ${list.length} аккаунтам?`)) return;
  const r = await post('/api/accounts/profile-all', {about});
  if (r && r.ok === false) alert(r.reason || 'не вышло');
  state();
};
$('#b-picall').onclick = async () => {
  const list = accs.filter(a => a.session);
  if (!list.length) { alert('Нет вошедших аккаунтов'); return; }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    if (!confirm(`Поставить эту аватарку всем ${list.length} вошедшим аккаунтам?`)) return;
    $('#status-t') && ($('#status-t').textContent = 'ставлю аватарку всем…');
    const res = await fetch('/api/accounts/photo-all', {
      method: 'POST',
      headers: {'x-filename': encodeURIComponent(inp.files[0].name), 'x-panel': '1'},
      body: inp.files[0],
    }).then(r => r.json()).catch(() => ({ok: false}));
    if (!res.ok) alert(res.reason || 'не удалось');
    state();
  };
  inp.click();
};
$('#b-prxall').onclick = async () => {
  const cur = accs.find(a => a.proxy)?.proxy || '';
  const p = prompt('Какой прокси поставить ВСЕМ аккаунтам?\n\n' +
    'Формат: host:port  либо  host:port:логин:пароль\n' +
    'Можно с протоколом: socks5://host:port\n\nПустая строка — снять прокси со всех.', cur);
  if (p === null) return;
  const r = await post('/api/accounts/proxy', {proxy: p, all: true});
  if (!r.ok) alert(r.reason || 'не у всех получилось');
  if (r.warn) alert(r.warn);
  accsRaw = ''; loop();
};

// Свой IP каждому: отдельная мобильная сессия Asocks на аккаунт (проверяется перед выдачей)
$('#b-ownip').onclick = async () => {
  const how = prompt('Свой IP каждому аккаунту — своя постоянная строка Asocks: Казахстан, закреплённый регион, своя сессия.\n\n' +
    'Каждую строку панель сначала проверит: отвечает, IP не скачет, пускает к Telegram, ' +
    'такого IP нет у другого аккаунта. Прежний прокси сохранится в proxyPrev.\n' +
    'Платим, как и раньше, только за трафик. Аккаунты пойдут параллельно ' +
    '(не больше 6 задач разом).\n\n' +
    '  1 — всем вошедшим аккаунтам\n  2 — только тем, у кого прокси общий, лежит или строка старого вида\n\nВведи 1 или 2:', '2');
  if (how === null) return;
  const r = await post('/api/proxy/own', {down: how.trim() !== '1'});
  if (!r.ok) { alert(r.reason || 'не вышло'); return; }
  alert(`Раздаю свой IP ${r.n} акк. — это несколько минут, ход и итог видно в журнале.`);
  accsRaw = ''; loop();
};

document.addEventListener('change', async (e) => {
  if (!e.target.matches('[data-warmcrew]')) return;
  const ids = [...document.querySelectorAll('#warm-crew [data-warmcrew]:checked')].map(c => c.dataset.warmcrew);
  try { await post('/api/warmup/crew', {ids}); } catch {}
});

$('#b-rotate').onclick = async () => {
  const url = $('#rotate').value.trim();
  if (!url) { alert('Вставь ссылку смены IP из личного кабинета прокси'); return; }
  $('#rotnote').textContent = 'спрашиваю прокси…';
  const r = await post('/api/proxy/rotate', {url});
  $('#rotnote').textContent = r.ok
    ? `✓ прокси ответил: ${r.text || 'ок'}\nIP меняется — можно запускать`
    : `✗ ${r.reason}`;
};
// ротация без очереди бессмысленна: покажем это прямо галочкой
$('#rotate').oninput = () => {
  // ссылка смены IP — только по очереди: параллельно все сидели бы на одном адресе
  if ($('#rotate').value.trim()) { $('#p-parallel').checked = false; $('#p-parallel').disabled = true; }
  else $('#p-parallel').disabled = false;
};

document.querySelectorAll('button[data-t]').forEach(b => b.onclick = async () => {
  const t = b.dataset.t;
  const multi = t !== 'login';   // всё, кроме входа, идёт на отмеченных аккаунтах
  const drafts = t === 'drafts';
  const voiceMode = drafts && $('#voicemode').checked;

  // кто участвует: для проверки/рассылки — набор work, иначе выбранный (cur)
  const chosen = accs.filter(a => work.has(a.id) && accReady(a)).map(a => a.title);
  if (multi && !chosen.length) { alert('Отметь хотя бы один вошедший аккаунт'); return; }
  const whoList = chosen.join(', ');
  const per = drafts ? $('#dlimit').value : $('#limit').value;

  if (voiceMode &&
      !confirm(`Голосовое уйдёт людям ПО-НАСТОЯЩЕМУ — до ${per} с каждого из: ${whoList}.\n\nОтозвать нельзя. Продолжить?`)) return;
  if (drafts && !voiceMode && $('#send').checked &&
      !confirm(`Сообщения уйдут людям ПО-НАСТОЯЩЕМУ — до ${per} с каждого из: ${whoList}.\n\nОтозвать нельзя. Продолжить?`)) return;

  const payload = {
    name: t,
    // набор — последней открытой вкладки рассылки (её же отмеченные аккаунты);
    // в «Обслуживании» это написано словами (#tools-set). Проверка номеров —
    // всегда по номерам: у набора чатов проверять нечего
    set: t === 'check' ? 'phones' : pickSet,
    warm: $('#warmon') ? $('#warmon').checked : true,
    limit: per,
    delay: drafts ? $('#ddelay').value : $('#delay').value,
    delayMax: drafts ? $('#ddelaymax').value : undefined,
    hold: drafts ? $('#dhold').value : undefined,
    holdMax: drafts ? $('#dholdmax').value : undefined,
    send: drafts && !voiceMode && $('#send').checked,
    voice: voiceMode,
  };
  if (multi) payload.accounts = accs.filter(a => work.has(a.id) && accReady(a)).map(a => a.id);
  else payload.account = cur;

  const r = await post('/api/start', payload);
  if (!r.ok && r.reason) alert(r.reason);
  else if (multi && r.skipped && r.skipped.length) alert('Запущено: ' + r.started + '\nПропущены:\n' + r.skipped.join('\n'));
  state();
});

/**
 * «Черновик / отправлять сразу» — крупным выбором. Внутри всё по-прежнему
 * висит на галочке #send: её читают и запуск, и ручные заходы, и подтверждения.
 */
function sendModeChange() {
  const send = $('#sm-send').checked;
  $('#send').checked = send;
  $('#b-drafts').textContent = send ? 'Отправить — один заход' : 'Разложить черновики — один заход';
  paintAuto();
}
$('#sm-draft').onchange = sendModeChange;
$('#sm-send').onchange = sendModeChange;

$('#send').onchange = () => {
  $('#sendwarn').hidden = !$('#send').checked;
  $('#b-drafts').textContent = $('#send').checked ? 'Написать и отправить' : 'Написать';
  paintAuto();
};

$('#b-reset').onclick = async () => {
  const who = accs.map(a => a.title).join(', ');
  if (!confirm(
      'Выйти из всех аккаунтов и очистить панель?\n\n' +
      (who ? `Выйдут: ${who}.\n\n` : '') +
      'Каждый аккаунт выйдет из Telegram ПО-НАСТОЯЩЕМУ: сессия будет отозвана, ' +
      'и вернуть аккаунт можно будет только новым входом — по QR или телефону. ' +
      'Залитый TDATA после этого работать не будет.\n\n' +
      'База, результаты, история сообщений и файлы сессий уедут в бэкап-папку ' +
      'рядом с панелью. Сводка за всё время останется в панели.\n\nПродолжить?')) return;
  const back = () => { $('#b-reset').disabled = false;
                       $('#b-reset').textContent = 'Выйти из всех аккаунтов и очистить'; };
  // кнопку гасим сразу: чистка идёт минутами, и второе нажатие по ней —
  // самый лёгкий способ запутать и себя, и панель
  $('#b-reset').disabled = true; $('#b-reset').textContent = 'Останавливаю и выхожу…';
  $('#stop').disabled = true;
  const r = await post('/api/reset', {});
  if (!r.ok) { alert(r.reason || 'не удалось'); back(); return; }
  // выход идёт по сети: ждём, пока панель отработает, но не вечно
  for (let i = 0; i < 240 && r.started; i++) {
    await new Promise(z => setTimeout(z, 1000));
    await tail();
    let s = null;
    try { s = await (await fetch('/api/state')).json(); } catch {}
    if (s && !s.wiping) break;
    if (i === 239) { alert('Выход затянулся — посмотри журнал.'); back(); return; }
  }
  $('#stop').disabled = false;
  alert('Готово — панель как новая. Сводка за всё время сохранена.');
  location.reload();
};

// импорт готовой сессии: заводим аккаунт с method:'file', затем шлём файл
const importFile = (accId, file) => {
  $('#status-t').textContent = `загружаю ${file.name}…`;
  return fetch('/api/accounts/import?account=' + encodeURIComponent(accId), {
    method: 'POST',
    headers: {'x-filename': encodeURIComponent(file.name), 'x-panel': '1'},
    body: file,
  }).then(r => r.json());
};

/**
 * Пакетный импорт: выбираешь сразу много файлов сессий (.zip TDATA или
 * .session) — панель заводит по аккаунту на файл и подключает их по очереди.
 * Имя берём из имени файла: там обычно номер. Прокси спрашиваем один раз на всех.
 */
/**
 * Открыть сразу несколько аккаунтов в одном Telegram Desktop — переключение
 * по аватарке слева внизу. Больше трёх в одну папку не влезает, это предел
 * самого десктопа. Как и в одиночном открытии, сначала пустой запуск под
 * прокси, потом уже с аккаунтами.
 */
$('#b-pack').onclick = async () => {
  const chosen = accs.filter(x => work.has(x.id) && accReady(x));
  if (!chosen.length) { alert('Отметь галочками аккаунты, которые открыть.'); return; }
  const take = chosen.slice(0, 3);
  const how = prompt(
    `Открыть в одном Telegram Desktop: ${take.map(x => x.title).join(', ')}` +
    (chosen.length > 3 ? `\n(отмечено ${chosen.length}, но десктоп держит только 3 — беру первые три)` : '') +
    `\n\n  1 — ПОДГОТОВИТЬ: пустой запуск, прописать прокси, закрыть.\n` +
    `  2 — ОТКРЫТЬ аккаунты (после шага 1).\n\nВведи 1 или 2:`, '1');
  if (how === null) return;
  const step = how.trim() === '2' ? 'open' : 'proxy';
  const r = await post('/api/accounts/desktop/pack', {ids: take.map(x => x.id), step});
  if (!r.ok) { alert(r.reason || 'не удалось'); return; }
  if (step === 'proxy') {
    alert('Десктоп открыт пустым — аккаунтов в нём нет.\n\n' +
      'Настройки → Продвинутые → Тип соединения → Свой прокси,\n' +
      `SOCKS5: ${take[0].proxyLabel}\n\nПотом закрой окно и нажми кнопку снова, выбрав 2.`);
    return;
  }
  alert(`Собираю папку на ${r.n} аккаунт(а) — это займёт несколько секунд,\n` +
    'ход виден в журнале. Десктоп откроется сам.\n\n' +
    'Переключение между аккаунтами — по аватарке слева внизу.\n' +
    'Не выходи там из аккаунтов: ключи общие с панелью.');
  state();
};

/**
 * Окно выбора файлов браузер открывает только «по горячему следу» клика.
 * prompt() этот след съедает: после него первый .click() по скрытому полю
 * молча ничего не делает, и список открывается лишь со второго нажатия.
 * Поэтому порядок обратный: сначала файлы, потом вопрос про прокси.
 */
$('#b-bulk').onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.zip,.session'; inp.multiple = true;
  inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    const p = prompt('Через какой прокси будут ходить эти аккаунты?\n\n' +
      'Формат: host:port  либо  host:port:логин:пароль\n' +
      'Пустая строка — напрямую, со своего IP.\n\nОдин прокси на всю пачку.',
      accs.find(a => a.proxy)?.proxy || '');
    if (p === null) return;
    if (!confirm(`Залить ${files.length} сесси(й)?\n\nПанель заведёт по аккаунту на файл и подключит их по очереди.`)) return;
    let ok = 0; const bad = [];
    for (const f of files) {
      // имя: номер из имени файла, иначе само имя файла
      const digits = (f.name.match(/\d{10,15}/) || [])[0];
      const title = digits ? '+' + digits : f.name.replace(/\.(zip|session)$/i, '');
      $('#status-t').textContent = `завожу ${title}…`;
      const a = await post('/api/accounts/add', {title, proxy: p, method: 'file'});
      if (!a.ok) { bad.push(`${f.name}: ${a.reason || 'не завёлся'}`); continue; }
      const res = await importFile(a.id, f);
      if (res.ok) ok++; else { bad.push(`${f.name}: ${res.reason || 'не подключился'}`); await post('/api/accounts/remove', {id: a.id}); }
    }
    alert(`Залито: ${ok} из ${files.length}.` +
      (bad.length ? `\n\nНе вышло:\n${bad.join('\n')}` : '') +
      `\n\nПодключение идёт в фоне — смотри строки аккаунтов. У новых начнётся отлёжка на сутки.`);
    accsRaw = ''; loop();
  };
  inp.click();
};

$('#b-add').onclick = async () => {
  const t = prompt('Как назвать аккаунт? (например: Андрей, рабочий)', `Аккаунт ${accs.length + 1}`);
  if (t === null) return;
  const p = prompt(`Через какой прокси заходить «${t}»?\n\nФормат: host:port  либо  host:port:логин:пароль\nМожно с протоколом: socks5://host:port\n\nПустая строка — заходить напрямую, со своего IP.`, '');
  if (p === null) return;
  const how = prompt('Как подключить аккаунт?\n\n  1 — по QR-коду (вход телефоном)\n' +
    '  2 — готовой сессией: TDATA (.zip) или .session (можно .zip с .session и .json)\n' +
    '  3 — по номеру телефона: Telegram пришлёт код, панель спросит его тут же\n\nВведи 1, 2 или 3:', '1');
  if (how === null) return;

  if (how.trim() === '3') {
    const tel = prompt(`Номер аккаунта «${t}» — с кодом страны.\n\nНапример: +79001112233`, '+7');
    if (tel === null) return;
    const r = await post('/api/accounts/add', {title: t, proxy: p, method: 'code', phone: tel});
    if (!r.ok) { alert(r.reason || 'не удалось'); return; }
    if (r.warn) alert(r.warn);
    pick(r.id);
    alert('Telegram отправляет код. Как придёт — панель спросит его сама,\nздесь же, отдельным окном.');
    loop();
    return;
  }

  if (how.trim() === '2') {
    const r = await post('/api/accounts/add', {title: t, proxy: p, method: 'file'});
    if (!r.ok) { alert(r.reason || 'не удалось'); return; }
    if (r.warn) alert(r.warn);
    pick(r.id);
    // просим файл
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.zip,.session';
    inp.onchange = async () => {
      if (!inp.files[0]) { await post('/api/accounts/remove', {id: r.id}); loop(); return; }
      const res = await importFile(r.id, inp.files[0]);
      if (!res.ok) alert(res.reason || 'не удалось загрузить');
      else alert(`Файл принят как ${res.kind}. Подключаю сессию — смотри журнал внизу.`);
      loop();
    };
    inp.click();
    return;
  }

  const r = await post('/api/accounts/add', {title: t, proxy: p});
  if (!r.ok) { alert(r.reason || 'не удалось'); return; }
  if (r.warn) alert(r.warn);
  pick(r.id);
  alert('Откроется окно Telegram с QR-кодом — отсканируй его телефоном.\n(Telegram → Настройки → Устройства → Подключить устройство)');
  loop();
};
/* ═══════════ БАЗА ПОЛУЧАТЕЛЕЙ — файл с номерами и люди из чатов ═══════════ */


const base = async () => {
  try {
    const b = await (await fetch('/api/base')).json();
    $('#basenow').innerHTML = b.count
      ? `<b>${b.count}</b> получателей${b.file ? ` · из <b style="font-weight:600">${b.file}</b>` : ''}` +
        (b.at ? ` <span style="color:var(--mut)">· загружена ${new Date(b.at).toLocaleString('ru-RU')}</span>` : '')
      : '<span style="color:var(--mut)">базы пока нет — загрузи файл</span>';
    $('#peek').textContent = b.rows.length
      ? b.rows.map(r => r.phone.startsWith('+')
          ? `${r.phone}   звонков ${r.calls || 1}   ${(r.last_call || '').slice(0, 16)}`
          : `${r.phone}   из чата`).join('\n')
        + (b.count > b.rows.length ? `\n… и ещё ${b.count - b.rows.length}` : '')
      : '';
  } catch {}
};

/**
 * Разбор чата: сколько людей собрано и из каких чатов. Это второй способ
 * набрать получателей — очередь у них дальше общая с проверенными номерами,
 * поэтому отдельной кнопки «написать им» не нужно.
 */
const members = async () => {
  try {
    const m = await (await fetch('/api/members')).json();
    // считаем не только разобранное чатами: готовый список @username из файла
    // ложится в ту же очередь, а в members.csv его нет
    const have = m.count || m.queued;
    $('#memnow').innerHTML = m.parsing
      ? '<span style="color:var(--mut)">иду по чатам, собираю участников…</span>'
      : have
        ? `<b>${have}</b> человек без номера` +
          `<span style="color:var(--mut)">${m.walked ? ` · из ${m.walked} чат(ов)` : ''}` +
          ` · в очереди ${m.queued - m.written} · написано ${m.written}</span>` +
          (m.solo
            ? `<span style="color:var(--mut);flex-basis:100%">` +
              `${m.queued - m.solo} напишет любой аккаунт (у них есть @username), ` +
              `${m.solo} — только тот, который их нашёл</span>`
            : '')
        : '<span style="color:var(--mut)">пока никого — сложи чаты в папку и нажми «Собрать из папки»</span>';
    $('#mempeek').textContent = m.rows.length
      ? m.rows.map(r => `${r.key}   ${r.name || ''}   ${r.chat ? '· ' + r.chat : ''}`).join('\n')
        + (m.chats.length > 1 ? '\n\nчаты: ' + m.chats.map(c => `${c.title} (${c.n})`).join(', ') : '')
      : '';
    noPhone = Math.max(0, m.queued - m.written);
    msgPreview();
    $('#s2').classList.toggle('done', have > 0);
    $('#b-memcsv').hidden = !m.count;   // выгружать нечего, пока не разбирали чаты
  } catch {}
};

/**
 * Один чат по ссылке разбирает ОДИН аккаунт. Папку и список панель делит
 * между всеми свободными аккаунтами (по одному на прокси) — см. startParseAll.
 */
const parser = () => accs.find(a => (work ? work.has(a.id) : false) && accReady(a) && !a.busy)
                  || accs.find(a => accReady(a) && !a.busy);

const startParse = async (opts) => {
  // папка и список — всеми свободными аккаунтами сразу, чаты делятся между ними
  const all = !!(opts.folder || opts.list);
  const who = all ? null : parser();
  if (!all && !who) { alert('Отметь хотя бы один вошедший и свободный аккаунт'); return; }
  const r = await post('/api/start',
    {name: 'parse', ...(all ? {all: true} : {account: who.id}), limit: $('#mlimit').value,
     onlyUser: $('#monly').checked, ...opts});
  if (!r.ok && r.reason) alert(r.reason);
  else if (all && r.started > 1 && $('#list-note')) {
    $('#list-note').textContent = `разбор пошёл параллельно — аккаунтов: ${r.started} (${(r.names || []).join(', ')})`;
  }
  state();
};

$('#b-folder').onclick = () => {
  const folder = $('#mfolder').value.trim();
  if (!folder) { alert('Назови папку, которую панель должна обойти'); return; }
  startParse({folder, again: $('#magain').checked});
};
$('#b-list').onclick = () => {
  const list = $('#chatlist').value.trim();
  if (!list) { alert('Вставь ссылки на чаты — по одной в строке'); return; }
  const n = list.split('\n').filter(x => x.trim()).length;
  if ($('#mjoin').checked &&
      !confirm(`Свободные аккаунты (по одному на прокси) поделят список и вступят в закрытые чаты по приглашениям, если ещё не в них.\n\nСписок: ${n} ссылок. Продолжить?`)) return;
  $('#list-note').textContent = `${n} ссылок ушло в разбор — ход по каждому чату в «Что происходит» внизу`;
  startParse({list, join: $('#mjoin').checked, again: $('#magain').checked});
};
$('#b-parse').onclick = () => {
  const chat = $('#chat').value.trim();
  if (!chat) { alert('Вставь ссылку на чат'); return; }
  const who = parser();
  if (who && $('#mjoin').checked &&
      !confirm(`«${who.title}» вступит в этот чат, если ещё не состоит в нём.\n\nПродолжить?`)) return;
  startParse({chat, join: $('#mjoin').checked});
};
$('#chat').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#b-parse').click(); });
$('#mfolder').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#b-folder').click(); });
$('#b-memcsv').onclick = () => { location.href = '/api/members/csv'; };

const upload = async (file) => {
  if (!file) return;
  baseLoading = true;
  paintStage($('#stage'), 'phones', (autoLast.runs || {}).phones || {}, autoLast);
  $('#basenow').innerHTML = `<span style="color:var(--mut)">отправляю ${file.name}…</span>`;
  const r = await (await fetch('/api/upload', {
    method: 'POST',
    headers: {'x-filename': encodeURIComponent(file.name), 'x-panel': '1'},
    body: file,
  })).json();
  if (!r.ok) { alert(r.reason || 'не удалось загрузить'); base(); return; }
  state();
};

$('#drop').onclick = () => $('#file').click();
$('#file').onchange = (e) => upload(e.target.files[0]);
['dragenter','dragover'].forEach(ev => $('#drop').addEventListener(ev, (e) => {
  e.preventDefault(); $('#drop').classList.add('over');
}));
['dragleave','drop'].forEach(ev => $('#drop').addEventListener(ev, (e) => {
  e.preventDefault(); $('#drop').classList.remove('over');
}));
$('#drop').addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
// файл, брошенный мимо зоны, не должен открываться вкладкой поверх панели
['dragover','drop'].forEach(ev => document.addEventListener(ev, (e) => e.preventDefault()));

$('#b-load').onclick = async () => {
  const p = $('#basepath').value.trim();
  if (!p) { alert('Вставь путь к файлу базы'); return; }
  const r = await post('/api/loadbase', {path: p});
  if (!r.ok) alert(r.reason || 'не удалось'); else state();
};
$('#stop').onclick = async () => { await post('/api/stop'); state(); };
$('#logout').onclick = async () => { await post('/api/logout'); location.href = '/login'; };

/**
 * Прогрев поведением: кто чем занят и что сказал SpamBot. Тут важнее всего
 * не числа, а понимание «панель жива и аккаунты чем-то заняты» — иначе
 * выглядит так, будто ничего не происходит, и хочется всё потрогать руками.
 */
let warmOn = false, warmRotDirty = false;
const fmtWarmWait = (s) => s <= 0 ? 'пора' : s < 90 ? `${s} с`
  : s < 5400 ? `${Math.round(s / 60)} мин` : `${(s / 3600).toFixed(1)} ч`;
/* ═══════════ ПРОГРЕВ — расписание, срок, смена IP ═══════════ */


const warmup = async () => {
  try {
    const w = await (await fetch('/api/warmup')).json();
    warmOn = !!w.on;
    if (document.activeElement !== $('#warm-rotate') && !warmRotDirty) $('#warm-rotate').value = w.rotate || '';
    if (document.activeElement !== $('#warm-rotwait')) $('#warm-rotwait').value = w.rotateWait || 10;
    if (w.warmDays && $('#warmdays') && document.activeElement !== $('#warmdays')) {
      $('#warmdays').value = w.warmDays;
    }
    if (w.plan && $('#cap-plan')) {
      $('#cap-plan').innerHTML = w.plan.map((st, i) => {
        const last = i === w.plan.length - 1;
        const val = st.cap === 0 ? 'не пишет' : `до ${st.cap} в день`;
        const label = st.day === 0 ? 'первые сутки' : `с ${st.day}-го дня`;
        return `<div class="cap-row"><span class="cap-day">${label}</span>` +
               `<span class="cap-val ${last ? 'max' : ''}">${val}${last ? ' · максимум' : ''}</span></div>`;
      }).join('');
    }
    if (w.checkMax && document.activeElement !== $('#checkcap')) $('#checkcap').value = w.checkMax;
    for (const [box, note] of [['#cs-between', '#cs-between-note'], ['#p-between', '#p-between-note']]) {
      if ($(box) && document.activeElement !== $(box)) {
        $(box).checked = !!w.between;
        $(note).textContent = w.between && !w.on ? '⚠ прогрев выключен — живой день не идёт' : '';
      }
    }
    const maxNow = w.plan ? w.plan[w.plan.length - 1].cap : 15;
    if (document.activeElement !== $('#daycap')) $('#daycap').value = maxNow;
    $('#daycap-note').textContent = '';
    // при общем прокси без ссылки — предупреждаем прямо тут
    $('#warm-rot-note').textContent = w.alone && !w.rotate
      ? 'прокси одна строка на всех — если она сама не меняет IP, греются с одного'
      : (w.rotate ? 'ссылка задана — IP меняется между аккаунтами' : '');
    $('#b-warm').textContent = warmOn ? 'Выключить прогрев' : 'Включить прогрев';
    $('#b-warm').className = warmOn ? 'ghost' : 'primary';
    $('#warm-state').textContent = warmOn ? `работает по ${w.accounts.length} акк.` : '';
    // догрев между пачками рассылки («Живой день») — видно прямо тут, включён ли
    $('#warm-between').innerHTML = !warmOn
      ? '<span style="color:var(--mut)">Догрев между пачками рассылки тоже не идёт — он работает только при включённом прогреве.</span>'
      : w.between
        ? '<b style="color:var(--ok)">🌱 Догрев между пачками включён</b> <span style="color:var(--mut)">(«Живой день»): с 8 до 23 аккаунты в рассылке читают каналы, ставят реакции и переписываются</span>'
        : '<b>Догрев между пачками выключен</b> <span style="color:var(--mut)">— между письмами только 1–2 действия к утру</span>';
    const wb = $('#warm-between-btn');
    wb.hidden = !warmOn;
    wb.textContent = w.between ? 'Выключить догрев' : 'Включить догрев';
    wb.dataset.on = w.between ? '1' : '';
    /**
     * В списке прогрева — только те, кто ещё греется. Созревший уходит отсюда
     * сам и появляется свободным в обеих вкладках рассылки: там его отмечают
     * галочкой и пускают в работу. Иначе готовый аккаунт висел бы на прогреве,
     * пока про него не вспомнят.
     */
    // Кого греть — галочки по всем аккаунтам (пусто/все = греем всех)
    const cb = $('#warm-crew');
    if (cb && !cb.contains(document.activeElement)) {
      const only = new Set(w.only || []);
      const allOn = only.size === 0;
      cb.innerHTML = accs.filter(a => a.session).map(a => {
        const on = allOn || only.has(a.id);
        return `<label class="crewitem"><input type="checkbox" data-warmcrew="${a.id}"${on ? ' checked' : ''}>` +
          `<span>${esc(a.name || a.title)}</span></label>`;
      }).join('') || '<span class="hint">нет вошедших аккаунтов</span>';
    }
    const grown = w.accounts.filter(a => a.day >= a.fullDay && !a.resting);
    const warming = w.accounts.filter(a => !(a.day >= a.fullDay && !a.resting));
    const grownLine = grown.length
      ? `<p class="hint" style="margin:10px 0 0">Прогреты: <b>${grown.length}</b>` +
        ` — ${grown.map(a => esc(a.title)).join(', ')}</p>`
      : '';
    // простой журнал: последнее действие каждого аккаунта, свежие сверху
    if ($('#warm-log')) {
      const nm = new Map(accs.map(a => [a.id, a.name || a.title]));
      const ekbT = (ts) => new Date(ts).toLocaleTimeString('ru-RU',
        { timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit' });
      const rows = w.accounts.filter(a => a.act)
        .map(a => ({ id: a.id, title: a.title, act: a.act, busy: a.busy, ts: a.actAt || Date.now() }))
        .sort((x, y) => y.ts - x.ts);
      $('#warm-log').innerHTML = rows.length
        ? rows.map(a => `<div class="ev"><b style="color:var(--mut)">${ekbT(a.ts)}${a.busy ? ' ●' : ''}</b> ` +
            `${esc(nm.get(a.id) || a.title)} — ${esc(a.act)}</div>`).join('')
        : '<span class="hint">пока тихо — действия появятся, когда аккаунт проснётся</span>';
    }
    $('#warm-list').innerHTML = (warming.length ? warming.map(a => {
      // человеческий статус: что с аккаунтом прямо сейчас
      let now = '';
      const nextTxt = a.dayLeft <= 0 ? 'на сегодня всё' : `дальше через ${fmtWarmWait(a.wait)}`;
      if (!warmOn) now = '';
      else if (a.busy) now = `● сейчас: ${a.act || 'работает'}`;
      else if (a.resting) now = `на отлёжке — старт через ${fmtWarmWait(a.restLeft)}`;
      else if (a.act) {
        const ago = a.actAt ? ` (${agoJs(a.actAt)})` : '';
        now = `${a.act}${ago} · ${nextTxt}`;
      }
      else if (a.dayLeft <= 0) now = 'на сегодня всё, продолжит завтра';
      else if (a.wait <= 0) now = 'ждёт очереди…';
      else now = `следующий заход через ${fmtWarmWait(a.wait)}`;
      const col = a.busy ? 'var(--ok)' : 'var(--mut)';
      // полоса прогресса прогрева
      const pct = Math.max(0, Math.min(100, a.pct || 0));
      const done = a.day >= a.fullDay;
      const barCls = a.resting ? 'rest' : (done ? 'full' : '');
      const barLbl = a.resting
        ? `отлёжка · старт через ${fmtWarmWait(a.restLeft)}`
        : done
          ? `прогрет · день ${a.day}`
          : `прогрев ${pct}% · день ${a.day} из ${a.fullDay}`;
      return `
      <div class="arow">
        <b>${esc(a.title)}</b>
        <span style="color:${a.spam && !a.spamOk ? 'var(--no)' : 'var(--mut)'};font-size:12px">${
          esc(a.spam ? a.spam.slice(0, 70) : 'SpamBot ещё не спрашивали')}${
          warmOn ? ` · сегодня осталось ${Math.max(0, a.dayLeft)}` : ''}</span>
        <span class="w" style="color:${col}">${esc(now)}</span>
        <div class="wbar ${barCls}">
          <div class="track"><i style="width:${pct}%"></i></div>
          <small>${esc(barLbl)}</small>
        </div>
      </div>`; }).join('')
      : `<p style="color:var(--mut);margin:0">${w.accounts.length
          ? 'Все аккаунты прогреты — греть больше некого.' : 'Нет вошедших аккаунтов.'}</p>`) + grownLine;
  } catch {}
};

// максимум проверок номеров в день — тоже одна на всю панель, сохраняем сразу
$('#checkcap').onchange = async () => {
  const cap = Math.max(1, parseInt($('#checkcap').value) || 50);
  await post('/api/checkcap', {cap});
  warmup();
};
// максимум в день — одна настройка на всю панель: сохраняем сразу, без кнопки
$('#daycap').onchange = async () => {
  const cap = Math.max(1, parseInt($('#daycap').value) || 15);
  await post('/api/dailycap', {cap});
  warmup();
};
$('#b-warm').onclick = async () => {
  if (!warmOn && !confirm(
      'Включить прогрев поведением?\n\n' +
      'Аккаунты будут сами подписываться на каналы, читать ленту, ставить реакции ' +
      'и переписываться между собой — понемногу и с большими паузами.\n\n' +
      'Это настоящие действия в Telegram от ваших аккаунтов. Продолжить?')) return;
  await post('/api/warmup', {on: !warmOn,
    rotate: $('#warm-rotate').value.trim(), rotateWait: +$('#warm-rotwait').value || 10});
  warmRotDirty = false;
  warmup();
};

// warmRotDirty объявлен выше
$('#warm-rotate').oninput = () => { warmRotDirty = true; };
// догрев между пачками — настройка профиля, сохраняем сразу
$('#warm-between-btn').onclick = async () => {
  const r = await post('/api/warmup', {between: !$('#warm-between-btn').dataset.on});
  if (r && r.ok === false) alert(r.reason || 'не сохранилось');
  warmup();
};
// «Параллельно» — одна настройка на обе вкладки: прокси общий, и очередь у них
// общая, так что по-разному выставить их нельзя
for (const [a, b] of [['#p-parallel', '#cs-parallel'], ['#cs-parallel', '#p-parallel']]) {
  if ($(a)) $(a).addEventListener('change', () => { if ($(b)) $(b).checked = $(a).checked; });
}
for (const [box, note] of [['#cs-between', '#cs-between-note'], ['#p-between', '#p-between-note']]) {
  if ($(box)) $(box).onchange = async () => {
    const r = await post('/api/warmup', {between: $(box).checked});
    $(note).textContent = r && r.ok === false ? (r.reason || 'не сохранилось') : 'сохранено';
    warmup();
  };
}
// срок прогрева: за сколько дней аккаунт выходит на полный объём
if ($('#warmdays-save')) $('#warmdays-save').onclick = async () => {
  const days = Math.max(2, Math.min(21, parseInt($('#warmdays').value) || 7));
  const note = $('#warmdays-note');
  const r = await post('/api/warmup', {days});
  if (r && r.ok === false) { note.textContent = r.reason || 'не вышло'; return; }
  note.textContent = `сохранено: ${days} дн.`;
  setTimeout(() => { note.textContent = ''; }, 4000);
  warmup();
};

$('#warm-rot-save').onclick = async () => {
  const r = await post('/api/warmup', {rotate: $('#warm-rotate').value.trim(),
    rotateWait: +$('#warm-rotwait').value || 10});
  warmRotDirty = false;
  $('#warm-rot-note').textContent = r.ok
    ? (r.rotate ? 'сохранено — IP меняется между аккаунтами' : 'сохранено (ссылка пустая)')
    : (r.reason || 'не сохранилось');
};


/* ═══════════ ОТКРЫТЬ АККАУНТ НА СВОЁМ КОМПЬЮТЕРЕ ═══════════ */
/**
 * Панель живёт на сервере, а Telegram Desktop нужно открыть на компьютере
 * человека — из браузера процесс там не запустить. Поэтому кнопка отдаёт
 * архив: tdata аккаунта, мост до его прокси и один запускаемый файл.
 */
// Шаги показываем те же, что человек увидит в чёрном окне. С прокси их
// больше: Telegram не умеет включать его по ссылке из командной строки
// (проверено на 7.2.9), поэтому первый раз прокси вбивается руками.
const KIT_STEPS = {
  mac: ['Распакуй архив туда, где папка останется жить, — например в «Документы». Из архива не запускать.',
        'Первый раз: правой кнопкой по <b>«Открыть аккаунт.command»</b> → «Открыть» → в окне ещё раз «Открыть». Дальше хватит двойного щелчка.',
        'Откроется ПУСТОЙ Telegram — без аккаунта. Один раз добавь прокси: Settings → Advanced → Connection type → Use custom proxy → Add proxy → <b>SOCKS5, 127.0.0.1, порт 18080</b>, логин и пароль пустые. Save и закрой окно: ⌘Q.',
        'Telegram откроется снова — уже с аккаунтом и через его прокси. Переписывайся как обычно, закрывай через ⌘Q.'],
  win: ['Распакуй папку из архива — из архива не запускать.',
        'Двойной щелчок по <b>«Открыть аккаунт.bat»</b>. Если SmartScreen ругнётся: «Подробнее» → «Выполнить в любом случае».',
        'Откроется ПУСТОЙ Telegram — без аккаунта. Один раз добавь прокси: Settings → Advanced → Connection type → Use custom proxy → Add proxy → <b>SOCKS5, 127.0.0.1, порт 18080</b>, логин и пароль пустые. Save и закрой окно.',
        'Telegram откроется снова — уже с аккаунтом и через его прокси. В следующие разы пустого запуска не будет.'],
  linux: ['Распакуй папку туда, где она останется жить.',
        'В терминале: <b>./открыть-аккаунт.sh</b> (или двойным щелчком, если файловый менеджер умеет).',
        'Откроется ПУСТОЙ Telegram — без аккаунта. Один раз добавь прокси: Settings → Advanced → Connection type → Use custom proxy → Add proxy → <b>SOCKS5, 127.0.0.1, порт 18080</b>. Save и закрой окно: Ctrl+Q.',
        'Telegram откроется снова — уже с аккаунтом и через его прокси.'],
};
// Без прокси всё проще: ни моста, ни пустого запуска, ни настроек.
const KIT_STEPS_DIRECT = {
  mac: ['Распакуй архив туда, где папка останется жить. Из архива не запускать.',
        'Если нужен другой IP — включи свой VPN <b>до</b> запуска.',
        'Первый раз: правой кнопкой по <b>«Открыть аккаунт.command»</b> → «Открыть». Аккаунт откроется сразу.'],
  win: ['Распакуй папку из архива — из архива не запускать.',
        'Если нужен другой IP — включи свой VPN <b>до</b> запуска.',
        'Двойной щелчок по <b>«Открыть аккаунт.bat»</b>. Аккаунт откроется сразу.'],
  linux: ['Распакуй папку туда, где она останется жить.',
        'Если нужен другой IP — включи свой VPN <b>до</b> запуска.',
        'В терминале: <b>./открыть-аккаунт.sh</b>. Аккаунт откроется сразу.'],
};
// Убрать аккаунт с чужого компьютера можно только стиранием файлов: выход
// в самом Telegram отзовёт сессию и у панели.
const KIT_CLEAN = {
  mac: 'Убрать аккаунт с того компьютера: <b>«Убрать аккаунт с компьютера.command»</b> в той же папке. Выходить из аккаунта в Telegram нельзя — это отзовёт сессию и у панели.',
  win: 'Убрать аккаунт с того компьютера: <b>«Убрать аккаунт с компьютера.bat»</b> в той же папке. Выходить из аккаунта в Telegram нельзя — это отзовёт сессию и у панели.',
  linux: 'Убрать аккаунт с того компьютера: <b>./убрать-аккаунт.sh</b> в той же папке. Выходить из аккаунта в Telegram нельзя — это отзовёт сессию и у панели.',
};
const KIT_NEED = {
  mac: 'Нужны: <b>Telegram Desktop</b> с desktop.telegram.org (или <b>brew install --cask telegram-desktop</b>) и Python 3. Клиент из App Store не подходит — он не открывает чужую папку с аккаунтом.',
  win: 'Нужен <b>Telegram Desktop</b> с desktop.telegram.org. Версия из Microsoft Store не подходит — она не открывает чужую папку с аккаунтом.',
  linux: 'Нужны: <b>Telegram Desktop</b> (desktop.telegram.org или snap) и Python 3.',
};
let kitOs = /Win/i.test(navigator.userAgent) ? 'win'
          : /Mac/i.test(navigator.userAgent) ? 'mac' : 'linux';
let kitAcc = null;

function paintKit() {
  const a = kitAcc; if (!a) return;
  // Всегда через прокси аккаунта (тот же, что в панели): иначе Telegram увидит
  // аккаунт из двух разных стран и сбросит сессию. Выбора «без прокси» нет.
  $('#kit-who').innerHTML = `Аккаунт <b>${esc(a.name || a.title)}</b> · выходит через ${esc(a.proxyLabel)}`;
  document.querySelectorAll('#kit-os button').forEach(b =>
    b.classList.toggle('on', b.dataset.os === kitOs));
  const steps = KIT_STEPS[kitOs];
  // с отдельным входом убирать аккаунт файлами не нужно: хватит кнопки «выгнать»
  const tail = $('#kit-fresh').checked
    ? 'Убрать доступ: кнопка <b>«выгнать»</b> в списке устройств выше. Файлы у человека после этого мертвы — удалять не обязательно.'
    : KIT_CLEAN[kitOs];
  $('#kit-steps').innerHTML = steps.map(t => `<li>${t}</li>`).join('')
    + `<li class="hint" style="list-style:none;margin-left:-20px">${KIT_NEED[kitOs]}</li>`
    + `<li class="hint" style="list-style:none;margin-left:-20px">${tail}</li>`;

  // «Пульт» — только с отдельным входом (ключ панели так не раздаём): один архив
  // на несколько аккаунтов, любая ОС. В список идут остальные вошедшие, кроме текущего.
  const canPult = $('#kit-fresh').checked;
  $('#kit-more-box').hidden = !canPult;
  if (canPult) {
    const others = accs.filter(x => x.id !== a.id && accReady(x));
    const keep = new Set([...document.querySelectorAll('#kit-more input:checked')].map(c => c.dataset.more));
    $('#kit-more').innerHTML = others.length
      ? others.map(x => `<label class="r">
          <input type="checkbox" data-more="${x.id}" ${keep.has(x.id) ? 'checked' : ''}>
          <span class="nm">${esc(x.name || x.title)}</span>
          <span class="st">${esc(x.proxyLabel || '')}</span></label>`).join('')
      : '<div class="r"><span class="nm" style="color:var(--mut)">других вошедших нет</span></div>';
    $('#kit-more').onchange = () => { $('#kit-go').textContent = kitGoLabel(); };
  }
  $('#kit-go').textContent = kitGoLabel();
}

/** Что написать на кнопке: один комплект или пульт на несколько. */
function kitGoLabel() {
  const n = document.querySelectorAll('#kit-more input:checked').length;
  return n ? `⬇ Скачать пульт на ${n + 1} акк.` : '⬇ Скачать комплект';
}

function openKit(id) {
  kitAcc = accs.find(x => x.id === id);
  if (!kitAcc) { alert('Аккаунт не найден'); return; }
  $('#kit-note').textContent = '';
  $('#kit-devs').innerHTML = '';
  $('#kit-devs-note').textContent = '';
  paintKit();
  $('#kitdlg').showModal();
}

document.querySelectorAll('#kit-os button').forEach(b => b.onclick = () => {
  kitOs = b.dataset.os; paintKit();
});
$('#kit-close').onclick = () => $('#kitdlg').close();
$('#kit-fresh').onchange = () => paintKit();

/** Кто сейчас имеет доступ к аккаунту: панель и все впущенные компьютеры. */
async function kitDevices(kill) {
  if (!kitAcc) return;
  const note = $('#kit-devs-note');
  note.textContent = kill ? 'выгоняю…' : 'спрашиваю Telegram…';
  const r = kill
    ? await post('/api/accounts/devices', {id: kitAcc.id, kill})
    : await (await fetch('/api/accounts/devices?id=' + encodeURIComponent(kitAcc.id))).json();
  if (!r.ok) { note.textContent = r.reason || 'не вышло'; return; }
  note.textContent = '';
  const d = r.devices || [];
  $('#kit-devs').innerHTML = d.map(x => `<div class="r">
      <span class="nm">${x.panel ? '🖥 панель' : esc(x.device || 'компьютер')}</span>
      <span class="cnt">${esc(x.app || '')}</span>
      <span class="st">${esc(x.place || '')}${x.at ? ' · ' + esc(String(x.at).slice(0, 16).replace('T', ' ')) : ''}${
        x.panel ? '' : ` <button class="tag act" data-kick="${x.hash}">выгнать</button>`}</span>
    </div>`).join('') || '<div class="r"><span class="nm">устройств нет</span></div>';
  $('#kit-devs').querySelectorAll('[data-kick]').forEach(b => {
    b.onclick = (e) => { e.preventDefault(); kitDevices(b.dataset.kick); };
  });
}
$('#kit-devs-load').onclick = () => kitDevices('');
$('#kit-devs-kill').onclick = () => {
  if (confirm('Выгнать все компьютеры, кроме панели?\n\nУ людей Telegram с этим аккаунтом закроется. Панель продолжит работать.')) kitDevices('others');
};

$('#kit-go').onclick = async () => {
  if (!kitAcc) return;
  const note = $('#kit-note');
  const more = [...document.querySelectorAll('#kit-more input:checked')].map(c => c.dataset.more);
  const pult = more.length > 0;      // отмечены ещё аккаунты → собираем пульт

  const q = new URLSearchParams({ os: kitOs });   // прокси аккаунта зашивается всегда
  let path;
  if (pult) {
    q.set('ids', [kitAcc.id, ...more].join(','));
    path = '/api/accounts/pult?' + q;
  } else {
    q.set('id', kitAcc.id);
    if ($('#kit-fresh').checked) q.set('fresh', '1');
    path = '/api/accounts/kit?' + q;
  }

  $('#kit-go').disabled = true;
  note.textContent = pult
    ? `собираю пульт на ${more.length + 1} акк. — это может занять минуту…`
    : 'собираю комплект…';
  try {
    const r = await fetch(path);
    // ошибку сервер отдаёт как JSON, архив — как zip
    if (!(r.headers.get('content-type') || '').includes('zip')) {
      const j = await r.json().catch(() => ({}));
      note.textContent = j.reason || 'не вышло собрать';
      return;
    }
    const name = (r.headers.get('content-disposition') || '').match(/filename="(.+?)"/);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = name ? name[1] : (pult ? 'pult.zip' : 'tg-kit.zip');
    a.click();
    URL.revokeObjectURL(url);
    const skipped = +(r.headers.get('x-skipped') || 0);
    note.textContent = skipped
      ? `скачано, но ${skipped} акк. не вошли — смотри журнал панели`
      : 'скачано — дальше по шагам ниже';
  } catch (e) {
    note.textContent = 'не вышло: ' + e.message;
  } finally {
    $('#kit-go').disabled = false;
  }
};

// какой режим сейчас открыт — тяжёлые списки тянем только для него
function activeView() {
  const v = document.querySelector('.view.active');
  return v ? v.dataset.view : 'overview';
}
// Список найденных (30k строк) больше НЕ рисуем вживую — он вешал панель.
// Счётчики берём из /api/state, а полный список отдаём файлом по кнопке.
const loop = async () => {
  await accounts(); await state(); await tail(); await eventsFeed(); await qr(); await message(); await voice();
  if (busy) return;
  await base(); await repliesList(); await warmup(); await funnel(); await mirror();
  await traffic();
  if (activeView() === 'organic') { await organicView(); await commentsView(); }
  if (activeView() === 'leads') await leadsView();
  if (activeView() === 'chatsend') await members();
  if (activeView() === 'results') await resultsView();
};
loop(); setInterval(loop, 2000);

/* ═══════════ РЕЖИМЫ (боковая панель) ═══════════ */
const VIEW_TITLE = {
  overview: 'Обзор', accounts: 'Аккаунты', warmup: 'Прогрев', send: 'Рассылка по номерам',
  results: 'Результаты', chatsend: 'Рассылка по чатам', organic: 'Органика', tools: 'Обслуживание',
  leads: 'Лиды',
};
// по какому набору пойдут ручные заходы из «Обслуживания» — словами, а не молча
function paintToolsSet() {
  const el = $('#tools-set');
  if (el) el.innerHTML = `«Написать» пойдёт <b>${pickSet === 'chats' ? 'по чатам' : 'по номерам'}</b> ` +
    'отмеченными там аккаунтами — как на последней открытой вкладке рассылки. «Проверить базу» — всегда по номерам.';
}

function showView(name) {
  if (!VIEW_TITLE[name]) name = 'overview';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  document.querySelectorAll('.nav-i').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  const t = $('#view-title'); if (t) t.textContent = VIEW_TITLE[name];
  try { localStorage.setItem('tg-view', name); } catch {}
  // какая вкладка рассылки открыта — тот состав и считается выбранным:
  // по нему идут и запуск, и ручные заходы
  if (name === 'send' || name === 'chatsend') {
    const set = name === 'chatsend' ? 'chats' : 'phones';
    useWork(set);
    useSet(set, true);              // и база с результатами — про эту же вкладку
    // у вкладки свои последние настройки запуска — показываем именно их
    restoreFormFor(set);
    // снимка у вкладки ещё нет (ни разу не запускали) — то, что в форме сейчас и
    // что настроят здесь, и есть её настройки
    if (!formBySet[set]) formShownSet = set;
  }
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  window.scrollTo(0, 0);
  if (name === 'results') resultsView(true);
  if (name === 'tools') paintToolsSet();
}
document.querySelectorAll('.nav-i').forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); showView(a.dataset.view); };
});
// через делегирование: такие кнопки появляются и в списках, которые панель
// перерисовывает на ходу, — вешать обработчик на каждую пришлось бы заново
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) { e.preventDefault(); showView(b.dataset.goto); }
});
showView((location.hash || '').replace('#', '') || localStorage.getItem('tg-view') || 'overview');

/* ═══════════ ОБЗОР + КАЛЬКУЛЯТОР МОЩНОСТИ ═══════════ */
const nf = (n) => (n == null ? '—' : new Intl.NumberFormat('ru-RU').format(Math.round(n)));

// ── Трафик и прокси: итог и баланс Asocks + «за что» по задачам и аккаунтам ──
// Платный прокси считается за гигабайт; данные меняются раз в полчаса —
// спрашиваем раз в минуту, а не на каждом двухсекундном опросе панели.
/* ═══════════ КОММЕНТАРИИ В ЧАТАХ — сводка и очередь на одобрение ═══════════ */
let commentsAt = 0, commentsRaw = '';
async function commentsView(force) {
  if (!force && Date.now() - commentsAt < 15_000) return;
  commentsAt = Date.now();
  let c;
  try { c = await (await fetch('/api/comments')).json(); } catch { return; }
  const raw = JSON.stringify(c);
  if (raw === commentsRaw) return;          // ничего не поменялось — не трогаем (и правку в поле)
  commentsRaw = raw;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const review = c.reviewed < c.approveFirst;
  set('#cmt-state', !c.on
    ? 'Выключены. Включаются в warm-list.json → comments.on (образ и правила текста — comment-persona.txt).'
    : (review ? `Первые ${c.approveFirst} комментариев ждут одобрения здесь: разобрано ${c.reviewed}. `
              : 'Пишутся сами, без одобрения. ') +
      (c.held.length ? `Под ограничением комментировать можно: ${c.held.join(', ')}.` : ''));
  set('#cmt-day', c.stats.day); set('#cmt-week', c.stats.week);
  set('#cmt-chats', `${c.chats.assigned}/${c.chats.total}`); set('#cmt-deleted', c.stats.deleted);
  const box = $('#cmt-pending');
  if (box && !box.contains(document.activeElement)) {   // не сбиваем того, кто правит текст
    box.innerHTML = c.pending.length ? c.pending.map((p) => `
      <div class="cmt-item" data-id="${esc(p.id)}">
        <div><b>${esc(p.name)}</b> → ${esc(p.chat_title || p.chat)}</div>
        <div class="cmt-their">${esc(p.their_name || 'участник')}: ${esc(p.their)}</div>
        <textarea>${esc(p.decision && p.decision.text || p.reply)}</textarea>
        <div class="frow">${p.decision
          ? `<span class="hint">${p.decision.ok ? 'одобрен — уйдёт со следующим заходом аккаунта' : 'отклонён'}</span>`
          : '<button class="primary mini" data-ok="1">Одобрить</button><button class="ghost mini" data-ok="0">Отклонить</button>'}
        </div>
      </div>`).join('') : '<div class="hint">пусто</div>';
  }
  const rec = $('#cmt-recent');
  if (rec) rec.innerHTML = c.recent.length ? c.recent.map((r) => `<div class="trf-row"><span>${esc(r.name)} · ${esc(r.chat)}: ${esc(r.text)}</span><b>${new Date(r.at).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'})}</b></div>`).join('')
    : '<div class="hint">пока ни одного</div>';
}
$('#cmt-pending')?.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-ok]');
  if (!b) return;
  const item = b.closest('.cmt-item');
  b.disabled = true;
  try {
    const r = await post('/api/comments/decide', {
      id: item.dataset.id, ok: b.dataset.ok === '1', text: item.querySelector('textarea').value });
    if (!r.ok) alert(r.reason || 'не вышло');
  } catch (err) { alert(err.message); }
  commentsRaw = ''; await commentsView(true);
});

/* ═══════════ ОРГАНИКА — пул, персоны, резерв, сбор чатов, лиды ═══════════ */
let organicAt = 0, organicRaw = '', orgOn = false;
async function organicView(force) {
  if (!force && Date.now() - organicAt < 15_000) return;
  organicAt = Date.now();
  let d;
  try { d = await (await fetch('/api/organic')).json(); } catch { return; }
  const raw = JSON.stringify(d);
  if (raw === organicRaw) return;
  organicRaw = raw;
  orgOn = !!d.on;
  const tbtn = $('#org-toggle'), tst = $('#org-state');
  if (tbtn) { tbtn.textContent = d.on ? 'Выключить комментинг' : 'Включить комментинг'; tbtn.classList.toggle('danger', d.on); }
  if (tst) tst.textContent = d.on ? 'комментинг включён' : 'выключен — комментарии не пишутся';
  const pool = $('#org-pool');
  if (pool && !pool.contains(document.activeElement)) {
    pool.innerHTML = d.accounts.map((a) => `
      <label class="crew-i${a.authed ? '' : ' off'}">
        <input type="checkbox" data-pool="${esc(a.id)}" ${d.poolSet ? (a.inPool ? 'checked' : '') : 'checked'} ${a.authed ? '' : 'disabled'}>
        <span>${esc(a.name)}</span></label>`).join('') || '<div class="hint">нет аккаунтов</div>';
  }
  const ab = $('#org-accounts');
  if (ab && !ab.contains(document.activeElement)) {
    const opts = (cur) => [...new Set(['', ...d.personas, cur || ''])]
      .map((p) => `<option value="${esc(p)}"${p === (cur || '') ? ' selected' : ''}>${p ? esc(p) : '— без персоны —'}</option>`).join('');
    ab.innerHTML = d.accounts.map((a) => `
      <div class="frow" data-acc="${esc(a.id)}" style="align-items:center;gap:8px;margin-bottom:6px">
        <span style="min-width:150px">${esc(a.name)}${a.retired ? ' <span class="hint">(retired)</span>' : ''}</span>
        <select data-persona class="ftext" style="max-width:180px">${opts(a.persona)}</select>
        <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-reserve ${a.reserve ? 'checked' : ''}><span>резерв</span></label>
      </div>`).join('');
  }
  const sel = $('#org-disc-acc');
  if (sel && !sel.options.length) sel.innerHTML = d.accounts.filter((a) => a.authed).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  const lb = $('#org-leads');
  if (lb) lb.innerHTML = d.leads.length ? d.leads.map((l) => `<div class="trf-row"><span>@${esc(l.username || '—')} · ${esc(l.chat)}: ${esc((l.quote || '').slice(0, 80))}</span><b>${new Date(l.at).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'})}</b></div>`).join('') : '<div class="hint">пока нет</div>';
}
$('#org-toggle')?.addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await post('/api/organic/comments', { on: !orgOn }); } catch (err) { alert(err.message); }
  organicRaw = ''; await organicView(true); e.target.disabled = false;
});
$('#org-pool')?.addEventListener('change', async () => {
  const ids = [...document.querySelectorAll('#org-pool input[data-pool]:checked')].map((i) => i.dataset.pool);
  try { await post('/api/organic/pool', { ids }); } catch (err) { alert(err.message); }
  organicRaw = '';
});
$('#org-accounts')?.addEventListener('change', async (e) => {
  const row = e.target.closest('[data-acc]'); if (!row) return;
  const body = { id: row.dataset.acc };
  if (e.target.matches('[data-persona]')) body.persona = e.target.value;
  if (e.target.matches('[data-reserve]')) body.reserve = e.target.checked;
  try { const r = await post('/api/organic/account', body); if (!r.ok) alert(r.reason || 'не вышло'); } catch (err) { alert(err.message); }
  organicRaw = '';
});
async function runDiscover(dry) {
  const note = $('#org-disc-note'); if (note) note.textContent = 'запускаю…';
  try {
    const r = await post('/api/organic/discover', {
      account: $('#org-disc-acc')?.value, seeds: $('#org-disc-seeds')?.value, niche: $('#org-disc-niche')?.value,
      minSubs: $('#org-disc-subs')?.value, score: $('#org-disc-score')?.value, dry });
    if (note) note.textContent = r.ok ? 'пошёл — смотри журнал снизу' : (r.reason || 'не вышло');
  } catch (err) { if (note) note.textContent = err.message; }
}
$('#org-disc-dry')?.addEventListener('click', () => runDiscover(true));
$('#org-disc-run')?.addEventListener('click', () => runDiscover(false));

/* ═══════════ ЛИДЫ — обогащение: чаты → разбор по авторам → лиды ═══════════ */

const LD_STATUS = {
  new: 'в очереди', reading: 'читается', downloaded: 'ждёт разбора', analyzing: 'разбирается',
  done: '✓ разобран', skipped: 'пропущен', error: 'ошибка',
};
let leadsAt = 0, leadsRaw = '', ld = null;
// заметку модель пишет markdown-ом: заголовки и **жирное** показываем жирным, остальное как есть
const mdLite = (t) => esc(t).replace(/^#{1,4} +(.+)$/gm, '<b>$1</b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
async function leadsView(force) {
  if (!force && Date.now() - leadsAt < 4000) return;
  leadsAt = Date.now();
  let d;
  try { d = await (await fetch('/api/enrich')).json(); } catch { return; }
  const raw = JSON.stringify([d, accs.map((a) => [a.id, a.role, a.run, accReady(a)])]);
  if (raw === leadsRaw) return;
  leadsRaw = raw;
  ld = d;
  const free = (el) => el && !el.contains(document.activeElement);

  // что сейчас происходит — одной строкой сверху
  const busy = d.readers.filter((r) => r.busy).map((r) => `${esc(r.name)}: ${esc(r.busy.replace(/ — .*/, ''))}`);
  const working = d.on || d.finding || d.planning;
  runbar('#ld-runbar', working,
    d.planning ? '<b>Автопилот: модель разбирает запрос</b>'
      : d.auto ? '<b>Автопилот работает</b>'
      : d.on ? '<b>Сбор лидов идёт</b>' : d.finding ? '<b>Идёт поиск чатов</b>' : '<b>Сбор лидов выключен</b>',
    [d.analyzer ? `разбирает «${esc(d.analyzer.title)}»` : '', ...busy,
     d.finding ? `ключевиков осталось ${d.keywords.left}` : ''].filter(Boolean).join(' · ')
      || (d.planning ? 'подбирает ключевики — минута-две' : working ? 'ждёт свободного читателя'
        : 'напиши, кого ищем, отметь аккаунты и запусти автопилот'));
  navLamp('leads', working);

  // автопилот: запрос, кнопка и ход работы по шагам
  const aq = $('#ap-query');
  if (free(aq) && !aq.dataset.touched) aq.value = d.query || '';
  const ab = $('#ap-run');
  if (ab) {
    const on = d.auto || d.planning;
    ab.textContent = on ? 'Остановить автопилот' : 'Запустить автопилот';
    ab.classList.toggle('danger', on);
  }
  const an = $('#ap-note');
  if (an) an.textContent = d.planning ? 'модель разбирает запрос и подбирает ключевики…' : d.planErr || '';
  const c0 = d.counts || {};
  const step = (state, name, text) => `<div class="ap-step${state ? ' ap-' + state : ''}"><span class="ap-dot"></span><b>${name}</b><span>${text}</span></div>`;
  const stF = d.finding ? 'run' : d.keywords.total && !d.keywords.left && !d.similarLeft ? 'ok' : '';
  const reading = (c0.reading || 0), queued = (c0.new || 0), inAnalysis = (c0.downloaded || 0) + (c0.analyzing || 0);
  const apSteps = $('#ap-steps');
  if (apSteps) apSteps.innerHTML = (d.auto || d.planning || d.goal || d.planErr) ? [
    step(d.planning ? 'run' : d.planErr ? 'err' : d.goal ? 'ok' : '', 'План', d.planning ? 'модель разбирает запрос и подбирает ключевики'
      : d.planErr ? esc(d.planErr) : d.goal ? `ищем тех, кто ${esc(d.goal)}` : '—'),
    step(stF, 'Поиск чатов', d.keywords.total ? `ключевиков ${d.keywords.total}, осталось ${d.keywords.left}` +
      (d.similarLeft ? ` · каналов для похожих ${d.similarLeft}` : '') : '—'),
    step(reading ? 'run' : queued ? 'wait' : (c0.done ? 'ok' : ''), 'Чтение', `в очереди ${queued}, читается ${reading}`),
    step(d.analyzer ? 'run' : inAnalysis ? 'wait' : (c0.done ? 'ok' : ''), 'Разбор',
      d.analyzer ? `разбирается «${esc(d.analyzer.title)}»` : `разобрано чатов ${c0.done || 0}` + (inAnalysis ? `, ждут ${inAnalysis}` : '')),
    step(d.profileBusy ? 'run' : d.profileLeft ? 'wait' : (d.leadsTotal ? 'ok' : ''), 'Профили',
      d.profileLeft ? `осталось посмотреть ${d.profileLeft}` : d.leadsTotal ? 'посмотрены' : '—'),
    step(d.leadsTotal ? 'ok' : '', 'Лиды', `${d.leadsTotal}` + (d.leadsExcluded ? ` · исключено продавцов ${d.leadsExcluded}` : '')),
    // почему стоит: читатель на паузе после сбоя (нет связи, флуд), без входа, на отлёжке
    step((d.readers || []).some((r) => r.busy) ? 'run' : (d.readers || []).some((r) => r.rest || !r.ready) ? 'wait' : (d.readers || []).length ? 'ok' : '',
      'Читатели', (d.readers || []).map((r) => `${esc(r.name || r.title)}: ` + (r.busy ? esc(r.busy.split(' — ')[0].toLowerCase())
        : r.resting ? 'отлёжка первых суток' : r.rest ? `пауза ${r.rest} мин` + (r.note ? ` — ${esc(r.note)}` : '')
        : r.ready ? 'готов' : 'не готов: нет входа, заморожен или в резерве')).join(' · ') || 'не отмечены'),
  ].join('') : '';

  // читатели — галочки по всем вошедшим; занятые рассылкой не отмечаются
  const rd = $('#ld-readers');
  if (free(rd)) {
    const list = accs.filter(accReady);
    rd.innerHTML = list.map((a) => {
      const r = d.readers.find((x) => x.id === a.id);
      const why = a.run ? 'в рассылке' : r?.busy ? 'читает' : r?.resting ? 'отлёжка первых суток'
        : r?.rest ? `отдых ${r.rest} мин` : '';
      return `<label class="crew-i" title="${esc(r?.note || '')}">
        <input type="checkbox" data-reader="${esc(a.id)}" ${a.role === 'read' ? 'checked' : ''} ${a.run ? 'disabled' : ''}>
        <span>${esc(a.name || a.title)}${why ? ` <span class="hint">· ${esc(why)}</span>` : ''}</span></label>`;
    }).join('') || '<div class="hint">нет вошедших аккаунтов — подключи их на вкладке «Аккаунты»</div>';
  }

  const goal = $('#ld-goal');
  if (free(goal) && !goal.dataset.touched) goal.value = d.goal || '';
  const topic = $('#ld-topic');
  if (free(topic) && !topic.dataset.touched) topic.value = d.topic || '';
  const kw = $('#ld-kw');
  if (free(kw) && !kw.dataset.touched) kw.value = d.keywords.list.join('\n');
  const kn = $('#ld-kw-note');
  const sim = d.similarLeft ? ` · каналов, у которых проверим похожие: ${d.similarLeft}` : '';
  if (kn) kn.textContent = d.kwBusy ? 'модель подбирает ключевики — это минута-две…'
    : d.keywords.total ? `ключевиков ${d.keywords.total}, не пройдено ${d.keywords.left}${sim}. Список можно поправить — по строке на запрос.`
    : 'Модель предложит сотни запросов: застройщики, ЖК, районы, «ипотека екб»… Список можно поправить — по строке на запрос.' + sim;
  $('#ld-kw-make').disabled = !!d.kwBusy;
  const fb = $('#ld-find');
  fb.textContent = d.finding ? 'Остановить поиск' : 'Найти чаты';
  fb.classList.toggle('danger', !!d.finding);

  const c = d.counts || {};
  $('#ld-counts').innerHTML = [
    [c.new || 0, 'в очереди'], [(c.reading || 0) + (c.downloaded || 0) + (c.analyzing || 0), 'в работе'],
    [c.done || 0, 'разобрано'], [(c.error || 0) + (c.skipped || 0), 'пропущено'], [d.leadsTotal, 'лидов'],
  ].map(([n, t]) => `<div><b>${n}</b><span>${t}</span></div>`).join('');
  const rb = $('#ld-run');
  rb.textContent = d.on ? 'Остановить сбор' : 'Собрать лидов';
  rb.classList.toggle('danger', !!d.on);
  $('#ld-run-note').textContent = d.readers.length ? `читателей: ${d.readers.length}` : 'сначала отметь читателей (шаг 1)';

  const tbl = $('#ld-chats');
  if (tbl) {
    tbl.innerHTML = d.chats.length ? '<tr><th>Чат</th><th>Статус</th><th>Сообщ.</th><th>Авторов</th><th>Лидов</th><th></th></tr>' +
      d.chats.map((x) => {
        const act = ['error', 'skipped'].includes(x.status)
          ? `<button class="ghost mini" data-ldcmd="retry" data-key="${esc(x.key)}">перечитать</button>` : '';
        const del = ['new', 'error', 'skipped'].includes(x.status)
          ? `<button class="ghost mini" data-ldcmd="remove" data-key="${esc(x.key)}">убрать</button>` : '';
        return `<tr><td>${esc(x.title || x.ref)}<div class="hint">${esc(x.ref)}${x.source ? ' · ' + esc(x.source) : ''}</div></td>
          <td>${esc(LD_STATUS[x.status] || x.status)}${x.err ? `<div class="hint">${esc(x.err)}</div>` : ''}</td>
          <td>${x.msgs ?? ''}</td><td>${x.authors ?? ''}</td><td>${x.leads ?? ''}</td><td>${act} ${del}</td></tr>`;
      }).join('') + (d.chatsTotal > d.chats.length ? `<tr><td colspan="6" class="hint">и ещё ${d.chatsTotal - d.chats.length}</td></tr>` : '')
      : '<tr><td class="hint">очередь пуста — найди чаты по ключевикам или добавь ссылками</td></tr>';
  }

  $('#ld-leads-note').textContent = d.leadsTotal ? `лидов ${d.leadsTotal}, ещё не написали ${d.leadsLeft}` : '';
  const lb = $('#ld-leads');
  if (free(lb)) {
    const open = new Set([...lb.querySelectorAll('details[open]')].map((x) => x.dataset.key));
    lb.innerHTML = d.leads.length ? d.leads.map((l) => `
      <details class="ld-lead${l.excluded ? ' ld-out' : ''}" data-key="${esc(l.key)}" ${open.has(l.key) ? 'open' : ''}>
        <summary><b>${l.username ? '@' + esc(l.username) : esc(l.name || 'id ' + l.uid)}</b>
          ${l.username && l.name ? `<span class="hint">${esc(l.name)}</span>` : ''}
          ${l.score ? `<span class="ld-score" title="уверенность модели">${l.score}</span>` : ''}
          <span class="tag">${esc(l.status)}</span>
          ${l.profile ? `<span class="tag" title="профиль посмотрен">профиль${l.profile.channel ? ' + канал' : ''}</span>` : ''}
          <span class="hint">${esc(l.chats.join(', '))}</span>
          <div class="hint">${esc(l.excluded || l.why)}</div>
          ${Object.keys(l.facts || {}).length ? `<div class="ld-facts">${Object.entries(l.facts).slice(0, 8)
            .map(([k, v]) => `<span class="ld-fact"><i>${esc(k)}</i> ${esc(v)}</span>`).join('')}</div>` : ''}</summary>
        ${l.profile?.about ? `<div class="hint" style="margin-top:6px">О себе: ${esc(l.profile.about)}</div>` : ''}
        ${l.profile?.channel ? `<div class="hint">Личный канал: ${esc(l.profile.channel.title || '')}${l.profile.channel.username
          ? ' (@' + esc(l.profile.channel.username) + ')' : ''}${l.profile.channel.posts ? ', постов прочитано ' + l.profile.channel.posts : ''}</div>` : ''}
        <div class="ld-note">${mdLite(l.note)}</div>
      </details>`).join('') : '<div class="hint">пока нет — лиды появятся по мере разбора чатов</div>';
  }
}

['#ld-goal', '#ld-topic', '#ld-kw', '#ap-query'].forEach((id) => $(id)?.addEventListener('input', (e) => { e.target.dataset.touched = '1'; }));
const ldDo = async (url, data, note) => {
  let r;
  try { r = await post(url, data); } catch (err) { alert(err.message); return null; }
  if (r && r.ok === false && !r.ask) alert(r.reason || 'не получилось');
  else if (note && $(note)) $(note).textContent = '';
  leadsRaw = ''; await leadsView(true);
  return r;
};
$('#ld-readers')?.addEventListener('change', async (e) => {
  const id = e.target.dataset.reader; if (!id) return;
  const a = accs.find((x) => x.id === id) || {};
  if (e.target.checked && a.role === 'send' && !confirm(`«${a.name || a.title}» сейчас в рассылке. Сделать читателем? Людям он писать перестанет.`)) {
    e.target.checked = false; return;
  }
  await post('/api/accounts/role', { id, role: e.target.checked ? 'read' : 'warm' });
  await loop(); leadsRaw = ''; await leadsView(true);
});
$('#ld-goal-save')?.addEventListener('click', async () => {
  const g = $('#ld-goal'); await ldDo('/api/enrich/goal', { goal: g.value }); delete g.dataset.touched;
});
$('#ld-kw-make')?.addEventListener('click', async () => {
  const t = $('#ld-topic');
  if (!t.value.trim()) { alert('Напиши тему, например «Квартиры в Екатеринбурге»'); return; }
  const kw = $('#ld-kw');
  if (kw.value.trim() && !confirm('Подобрать ключевики заново? Текущий список заменится новым.')) return;
  delete t.dataset.touched; delete kw.dataset.touched;
  await ldDo('/api/enrich/keywords', { topic: t.value });
});
$('#ld-kw-save')?.addEventListener('click', async () => {
  const kw = $('#ld-kw');
  const r = await ldDo('/api/enrich/keywords-save', { list: kw.value });
  if (r?.ok) { delete kw.dataset.touched; $('#ld-find-note').textContent = `сохранено: ${r.total}, не пройдено ${r.left}`; }
});
$('#ld-find')?.addEventListener('click', async () => {
  const kw = $('#ld-kw');
  if (!ld?.finding && kw.dataset.touched) {
    const r = await post('/api/enrich/keywords-save', { list: kw.value });
    if (r && r.ok === false) { alert(r.reason); return; }
    delete kw.dataset.touched;
  }
  await ldDo('/api/enrich/find', { on: !ld?.finding });
});
$('#ld-links-add')?.addEventListener('click', async () => {
  const t = $('#ld-links');
  const r = await ldDo('/api/enrich/chats', { list: t.value });
  if (r?.ok) { $('#ld-links-note').textContent = `добавлено ${r.added} из ${r.given}` + (r.given > r.added ? ' (остальные уже в очереди)' : ''); t.value = ''; }
});
$('#ld-run')?.addEventListener('click', () => ldDo('/api/enrich/run', { on: !ld?.on }));
$('#ap-run')?.addEventListener('click', async () => {
  if (ld?.auto || ld?.planning) { await ldDo('/api/enrich/auto', { on: false }); return; }
  const q = $('#ap-query');
  const ids = [...document.querySelectorAll('#ld-readers input[data-reader]:checked')].map((i) => i.dataset.reader);
  if (!q.value.trim()) { alert('Напиши, кого ищем: например «хочет купить квартиру в Екатеринбурге»'); return; }
  if (!ids.length) { alert('Отметь аккаунты, которые будут искать и читать чаты'); return; }
  let r = await ldDo('/api/enrich/auto', { query: q.value, accounts: ids });
  if (r?.ask === 'queue') {
    // в очереди остались чаты прошлого запроса — решает владелец
    const clear = confirm(`В очереди ${r.n} чатов от прошлого запроса «${r.prev}».\n\n` +
      'ОК — отложить их и искать только по новому запросу (вернуть можно кнопкой «перечитать»).\n' +
      'Отмена — оставить: читатели сначала дочитают их.');
    r = await ldDo('/api/enrich/auto', { query: q.value, accounts: ids, queue: clear ? 'clear' : 'keep' });
  }
  if (r?.ok) delete q.dataset.touched;
});
$('#ld-chats')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ldcmd]'); if (!b) return;
  ldDo('/api/enrich/chats-cmd', { cmd: b.dataset.ldcmd, keys: [b.dataset.key] });
});
$('#ld-csv')?.addEventListener('click', () => { location.href = '/api/enrich/leads.csv'; });
$('#ld-write')?.addEventListener('click', async () => {
  if (!ld?.leadsTotal) { alert('Лидов пока нет — сначала собери их'); return; }
  const run = ((lastState && lastState.auto && lastState.auto.runs) || {}).chats || {};
  if (run.on) {
    alert(run.leadsOnly ? 'Рассылка лидам уже идёт. Остановить её можно на вкладке «Рассылка по чатам».'
      : 'Сейчас идёт рассылка по чатам. Останови её на вкладке «Рассылка по чатам», потом пиши лидам.');
    return;
  }
  // настройки и состав писателей — вкладки «Рассылка по чатам»
  // Пишут лидам с настройками вкладки «Рассылка по чатам» (текст, паузы, лимиты,
  // писатели). Ни разу её не запускали — снимка нет: в общей форме сейчас
  // настройки «по номерам», с ними лидам писать нельзя. Отправляем настроить.
  // В общей форме — настройки «по чатам»: правленые там (formShownSet) берём как
  // есть, иначе — снимок прошлого запуска по чатам. Нет ни того, ни другого —
  // отправляем на вкладку: там настроят, и следующее нажатие возьмёт это
  if (formShownSet !== 'chats') {
    if (!formBySet.chats) {
      alert('Сначала открой вкладку «Рассылка по чатам» и проверь там текст, паузы, лимиты и кто пишет. ' +
        'Лидам пишем с этими настройками — потом вернись и нажми «Написать лидам».');
      showView('chatsend');
      return;
    }
    applyForm(formBySet.chats);
    formShownSet = 'chats';
  }
  const back = pickSet;
  useWork('chats');
  await startAuto('chats', { leads: true });
  if (activeView() === 'leads') useWork(back);
});

let trafficAt = 0;
const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' ГБ'
  : b >= 1e6 ? (b / 1e6).toFixed(1) + ' МБ' : Math.round((b || 0) / 1e3) + ' КБ');
const usd = (x) => '$' + (x || 0).toFixed(x >= 1 ? 2 : 3);
async function traffic() {
  if (Date.now() - trafficAt < 60_000 || !$('#traffic-card') || $('#traffic-card').hidden) return;
  trafficAt = Date.now();
  let t;
  try { t = await (await fetch('/api/traffic')).json(); } catch { return; }
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const a = t.asocks || {};
  if (!a.on) set('#tr-asocks', 'Asocks не подключён: на сервере нет ключа API.');
  else if (a.empty) set('#tr-asocks', 'Asocks подключён — первый снимок баланса появится в течение получаса.');
  else {
    const at = new Date(a.at).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
    set('#tr-day', `${fmtBytes(a.day.bytes)} · ${usd(a.day.usd)}`);
    set('#tr-week', `${fmtBytes(a.week.bytes)} · ${usd(a.week.usd)}`);
    set('#tr-month', `${fmtBytes(a.month.bytes)} · ${usd(a.month.usd)}`);
    set('#tr-balance', usd(a.balance));
    set('#tr-runway', a.runwayDays ? `~${Math.floor(a.runwayDays)} дн.` : '—');
    set('#tr-asocks', `По данным Asocks на ${at}` +
      (a.usdPerGb ? ` · по факту ${usd(a.usdPerGb)} за ГБ` : '') +
      ` · учёт с ${new Date(a.since).toLocaleDateString('ru-RU')}`);
  }
  // модель (OpenRouter): баланс и расход — снимок раз в полчаса
  const lm = t.llm;
  const money = (x) => (x == null ? '—' : '$' + Number(x).toFixed(x >= 1 ? 2 : 3));
  set('#tr-llm', lm ? `Модель (OpenRouter): баланс ${lm.credits != null && lm.used != null ? money(lm.credits - lm.used) : '—'}` +
    (lm.credits != null ? ` из ${money(lm.credits)}` : '') +
    ` · за сутки ${money(lm.day)} · за 7 дней ${money(lm.week)} · за 30 дней ${money(lm.month)}` +
    ` · на ${new Date(lm.at).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})}` : '');
  const w = (t.tasks && t.tasks.week) || {byTask: {}, byAcc: {}, total: 0, paid: 0};
  const rows = (obj, names) => Object.entries(obj || {}).sort((x, y) => y[1] - x[1]).slice(0, 8)
    .map(([k, v]) => `<div class="trf-row"><span>${esc(names ? (names[k] || k) : k)}</span><b>${fmtBytes(v)}</b></div>`)
    .join('') || '<div class="hint">пока пусто — задачи начнут записывать свой трафик с этой версии</div>';
  $('#tr-tasks').innerHTML = rows(w.byTask);
  $('#tr-accs').innerHTML = rows(w.byAcc, t.names);
  // прод — его трафик по задачам и аккаунтам (виден только из своих профилей)
  const m = t.main && t.main.week;
  $('#tr-main-box').hidden = !m;
  if (m) {
    $('#tr-main-tasks').innerHTML = rows(m.byTask);
    $('#tr-main-accs').innerHTML = rows(m.byAcc, t.mainNames);
  }
  // расход по портам: у прода и теста свои логины — Asocks считает их отдельно
  const pts = ((a.ports || {}).ports || []).filter((x) => x.bytes > 0 || x.usd > 0)
    .sort((x, y) => y.usd - x.usd);
  $('#tr-ports').innerHTML = pts.length
    ? pts.map((x) => `<div class="trf-row"><span>${esc(x.name)}</span><b>${fmtBytes(x.bytes)} · ${usd(x.usd)}` +
        (x.bytes > 1e6 ? ` · ${usd(x.usd / (x.bytes / 1e9))}/ГБ` : '') + '</b></div>').join('')
    : '<div class="hint">появится со следующим снимком Asocks (раз в 30 мин)</div>';
  set('#tr-paid', w.total ? `Через платный прокси за 7 дней — ${fmtBytes(w.paid)} из ${fmtBytes(w.total)}; ` +
    'туннель на сервере бесплатный. Telegram на ПК из комплекта сюда не попадает, но тоже идёт через прокси.' : '');
  // сколько насчитал Asocks сверх того, что измерили сами задачи: проверки
  // прокси сторожем, рукопожатия, задачи других профилей — видно, куда уходит
  const dMeasured = (((t.tasks || {}).day || {}).paid || 0) + (((t.main || {}).day || {}).paid || 0);
  set('#tr-overhead', a.on && !a.empty && a.day && a.day.bytes > 0
    ? `За сутки Asocks насчитал ${fmtBytes(a.day.bytes)}, задачи ${t.main ? 'прода и этого профиля' : 'этого профиля'} ` +
      `измерили ${fmtBytes(dMeasured)} (${Math.round(100 * Math.min(1, dMeasured / a.day.bytes))}%). ` +
      'Остальное — проверки прокси, рукопожатия соединений и задачи других профилей.'
    : '');
}
// РАЗГОН РАССЫЛКИ по дню рассылки (не по возрасту прогрева): день 0 = первый день
// реальных сообщений. Аккаунт, который ещё не начинал слать, стартует с 2/день.
const OUTREACH_PLAN = [[0, 2], [2, 5], [4, 8], [6, 12], [9, 15]];
function outreachCap(outreachDay) {
  const d = outreachDay == null || outreachDay < 0 ? 0 : outreachDay;   // не начинали → как день 0
  let c = 2;
  for (const [pd, pc] of OUTREACH_PLAN) if (d >= pd) c = pc;
  return c;
}
// эффективный потолок дня: ручной override; иначе min(разгон рассылки, поведенческий
// прогрев, «максимум в день»)
function effCapDay(a, outreachDay, maxCap) {
  if (a.dailyCap && a.dailyCap > 0) return a.dailyCap;         // ручной предел (тест) — как есть
  const caps = [outreachCap(outreachDay)];
  if (a.warm && typeof a.warm.cap === 'number') caps.push(a.warm.cap);  // поведенческий потолок прогрева
  if (maxCap > 0) caps.push(maxCap);
  return Math.min(...caps);
}
const isReady = (a) => a.session && a.authed && a.role !== 'warm' && a.role !== 'read' && !(a.warm && a.warm.resting) && !a.quarantine;

function paintDash() {
  const total = accs.length;
  const entered = accs.filter((a) => a.session && a.authed).length;
  const resting = accs.filter((a) => a.session && a.authed && a.warm && a.warm.resting).length;
  const ready = accs.filter(isReady);
  const sentToday = accs.reduce((n, a) => n + (a.sentToday || 0), 0);
  const maxCap = Math.max(0, parseInt($('#daycap')?.value) || 15);
  const od = (a) => (typeof a.outreachDay === 'number' ? a.outreachDay : -1);

  // сегодня — по дню рассылки каждого аккаунта (не начинали → 2/день)
  const dayNow = ready.reduce((n, a) => n + effCapDay(a, od(a), maxCap), 0);
  // на плато — когда разгон дойдёт до конца (день рассылки ≥ 9)
  const dayMax = ready.reduce((n, a) => n + (a.dailyCap > 0 ? a.dailyCap : effCapDay(a, 9, maxCap)), 0);
  // за неделю — интеграл разгона: по каждому аккаунту суммируем его следующие 7 дней рассылки
  const week = ready.reduce((sum, a) => {
    const d0 = Math.max(0, od(a));
    let s = 0;
    for (let d = 0; d < 7; d++) s += (a.dailyCap > 0 ? a.dailyCap : effCapDay(a, d0 + d, maxCap));
    return sum + s;
  }, 0);

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('#ov-accs', nf(total)); set('#ov-accs-sub', 'вошло ' + nf(entered));
  set('#ov-warm', nf(resting)); set('#ov-warm-sub', 'готовы к работе ' + nf(ready.length));
  set('#ov-today', nf(sentToday)); set('#ov-today-sub', 'потолок сегодня ' + nf(dayNow));

  set('#calc-accs', nf(ready.length));
  set('#calc-day-now', nf(dayNow));
  set('#calc-day-max', nf(dayMax));
  set('#calc-week', nf(week));
}

// «а если бы аккаунтов было N по C сообщений»
function calcWhatIf() {
  const A = parseInt($('#calc-what-accs')?.value) || 0;
  const C = parseInt($('#calc-what-cap')?.value) || 0;
  const out = $('#calc-what-out'); if (!out) return;
  if (!A || !C) { out.textContent = ''; return; }
  out.textContent = `≈ ${nf(A * C)}/день · до ${nf(A * C * 7)}/неделю на плато`;
}
$('#calc-what-accs')?.addEventListener('input', calcWhatIf);
$('#calc-what-cap')?.addEventListener('input', calcWhatIf);

// обновляем обзор/калькулятор часто (данные тянет основной loop)
setInterval(paintDash, 1200); paintDash();

/* ═══════════ СКАЧИВАНИЕ СПИСКОВ (по запросу, не вживую) ═══════════ */
$('#b-found-csv')?.addEventListener('click', () => { location.href = '/api/found/csv'; });
// проверка ответов сейчас — сами аккаунты смотрят раз в 2 часа днём
$('#b-funnel-now')?.addEventListener('click', async () => {
  const msg = $('#funnel-now-msg');
  try {
    const r = await post('/api/funnel/now');
    msg.textContent = r.ok ? `поставил в очередь: ${r.n} акк., результаты появятся через несколько минут`
                           : (r.reason || 'не вышло');
  } catch (e) { msg.textContent = e.message; }
});
