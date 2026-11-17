'use strict';
/* ============================================================
   VIP Lounge — game.js
   IndexedDB · ленивые медиа · живой чат · дейтинг-карточка
   ============================================================ */
(() => {
  /* ---------- 1. Утилиты, константы, состояние ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const $id = id => document.getElementById(id);
  const rand = n => Math.floor(Math.random() * n);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const buzz = () => { if (navigator.vibrate) navigator.vibrate(15); };
  const shuffle = a => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) { const j = rand(i + 1); [b[i], b[j]] = [b[j], b[i]]; }
    return b;
  };

  const THUMB = 150, FEED_LIMIT = 120, SETTINGS_KEY = 'vip.settings', HOLD_KEY = 'vip.holdSeen';
  const DEFAULTS = { url: 'https://openrouter.ai', key: '', model: 'anthropic/claude-sonnet-4.5', size: 'short' };
  const state = {
    girls: [], session: [], tail: [], cur: null, idx: 0, token: 0, mediaURL: null, immersive: false,
    formMedia: [], formRemoved: [], editId: null, queue: Promise.resolve(), noKeyShown: false,
    holdSeen: localStorage.getItem(HOLD_KEY) === '1'
  };
  let db, settings = { ...DEFAULTS }, confirmResolve = null;
  const G = id => state.girls.find(g => g.id === id);

  const STARTERS = [
    { id: 'seed-alisa', name: 'Алиса', age: 22, hue: 340, status: 'Скучаю по вечерним разговорам',
      prompt: 'Нежная, игривая и чуть застенчивая. Любит дразнить комплиментами и называет собеседника «солнышко». Говорит тепло, с эмодзи.' },
    { id: 'seed-mira', name: 'Мира', age: 25, hue: 275, status: 'Ночная пташка · кофе и джаз',
      prompt: 'Загадочная и ироничная, говорит с лёгкой хитринкой. Обожает ночные беседы, джаз и философию. Отвечает лаконично, с подтекстом.' },
    { id: 'seed-lika', name: 'Лика', age: 20, hue: 25, status: 'Всегда в движении ⚡',
      prompt: 'Энергичная, смешная и прямолинейная. Занимается танцами, любит подкалывать и задавать неожиданные вопросы. Пишет быстро и эмоционально.' }
  ];
  const CANNED = [
    'Ммм, а ты умеешь заинтересовать 😏', 'Ха-ха, продолжай, мне нравится ход твоих мыслей 💕',
    'Расскажи ещё что-нибудь, я вся внимание ✨', 'Ой, ты меня смущаешь... но не останавливайся 🙈',
    'Знаешь, с тобой тут совсем не скучно 😉', 'Хм, неожиданно! Давай подробнее?'
  ];

  /* ---------- 2. IndexedDB ---------- */
  const dbp = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const txDone = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });
  const store = (n, mode = 'readonly') => db.transaction(n, mode).objectStore(n);
  const dbGet = (n, k) => dbp(store(n).get(k));
  const dbAll = n => dbp(store(n).getAll());
  const dbPut = (n, v) => dbp(store(n, 'readwrite').put(v));
  const dbAdd = (n, v) => dbp(store(n, 'readwrite').add(v));
  const dbDel = (n, k) => dbp(store(n, 'readwrite').delete(k));
  const dbByGirl = (n, id) => dbp(store(n).index('girlId').getAll(id));

  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('vip-lounge', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('girls', { keyPath: 'id' });
        d.createObjectStore('media', { keyPath: 'id', autoIncrement: true }).createIndex('girlId', 'girlId');
        d.createObjectStore('groupChat', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('privateChats', { keyPath: 'id', autoIncrement: true }).createIndex('girlId', 'girlId');
        d.createObjectStore('settings', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async function dbDelByGirl(n, id) {
    const keys = await dbp(store(n).index('girlId').getAllKeys(id));
    const tx = db.transaction(n, 'readwrite');
    keys.forEach(k => tx.objectStore(n).delete(k));
    return txDone(tx);
  }

  /* ---------- 3. Настройки (localStorage) ---------- */
  const loadSettings = () => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
    catch { return { ...DEFAULTS }; }
  };
  const persistSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* квота */ } };

  function openSettings() {
    $id('s-url').value = settings.url;
    $id('s-key').value = settings.key;
    $id('s-model').value = settings.model;
    $(`input[name="reply-size"][value="${settings.size}"]`).checked = true;
    openModal('modal-settings');
  }

  function saveSettingsForm(e) {
    e.preventDefault();
    settings = {
      url: $id('s-url').value.trim() || DEFAULTS.url,
      key: $id('s-key').value.trim(),
      model: $id('s-model').value.trim() || DEFAULTS.model,
      size: $('input[name="reply-size"]:checked').value
    };
    persistSettings();
    state.noKeyShown = false;
    closeModal('modal-settings');
    toast('Настройки сохранены', 'ok');
  }

  /* ---------- 4. Интерфейс: тосты, модалки, экраны, вкладки ---------- */
  function toast(text, kind = '') {
    const box = $id('toasts'), t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    box.append(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 2600);
  }

  const openModal = id => { const m = $id(id); m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); };
  const closeModal = id => { const m = $id(id); m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); };

  function askConfirm(title, text) {
    $id('confirm-title').textContent = title;
    $id('confirm-text').textContent = text;
    openModal('modal-confirm');
    return new Promise(res => { confirmResolve = res; });
  }

  function answerConfirm(value) {
    closeModal('modal-confirm');
    if (confirmResolve) confirmResolve(value);
    confirmResolve = null;
  }

  function show(name) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
    document.body.dataset.screen = name;
  }

  function setTab(t) {
    document.body.dataset.tab = t;
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    $id('panel-chat').classList.toggle('active', t === 'chat');
    $id('panel-fav').classList.toggle('active', t === 'fav');
    if (t === 'fav') renderFav();
  }

  const setViewport = () => {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${h}px`);
    [$id('feed'), $id('pc-feed')].forEach(f => { f.scrollTop = f.scrollHeight; });
  };

  /* ---------- 5. Медиа: мини-превью и градиентные аватарки ---------- */
  const gradCache = new Map();

  function gradientURL(hue, name, w, h) {
    const key = `${hue}|${name}|${w}`;
    if (gradCache.has(key)) return gradCache.get(key);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const lin = x.createLinearGradient(0, 0, w, h);
    lin.addColorStop(0, `hsl(${hue},78%,58%)`);
    lin.addColorStop(.55, `hsl(${(hue + 35) % 360},70%,38%)`);
    lin.addColorStop(1, `hsl(${(hue + 300) % 360},60%,14%)`);
    x.fillStyle = lin; x.fillRect(0, 0, w, h);
    const rad = x.createRadialGradient(w * .3, h * .25, 0, w * .3, h * .25, w * .8);
    rad.addColorStop(0, 'rgba(255,230,210,.45)');
    rad.addColorStop(1, 'rgba(255,230,210,0)');
    x.fillStyle = rad; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,.85)';
    x.font = `800 ${Math.round(w * .5)}px sans-serif`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText((name.trim()[0] || '♥').toUpperCase(), w / 2, h * .52);
    const url = c.toDataURL('image/jpeg', .82);
    gradCache.set(key, url);
    return url;
  }

  const frameOf = url => new Promise((res, rej) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadeddata = () => { v.currentTime = Math.min(.2, (v.duration || .2) / 2); };
    v.onseeked = () => res(v);
    v.onerror = () => rej(new Error('video'));
    setTimeout(() => rej(new Error('timeout')), 8000);
    v.src = url;
  });

  async function makeThumb(file, isVideo, w = THUMB, h = THUMB) {
    const url = isVideo ? URL.createObjectURL(file) : null;
    let src;
    try {
      src = isVideo ? await frameOf(url) : await createImageBitmap(file);
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
      const k = Math.max(w / sw, h / sh), cw = w / k, ch = h / k;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(src, (sw - cw) / 2, (sh - ch) * .25, cw, ch, 0, 0, w, h);
      let out = c.toDataURL('image/webp', .95);
      if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/jpeg', .95);
      return out;
    } finally {
      if (isVideo && src) { src.removeAttribute('src'); src.load(); }
      else if (src && src.close) src.close();
      if (url) URL.revokeObjectURL(url);
    }
  }

  /* ---------- 6. Рендер: лента аватарок и избранные ---------- */
  function refreshSession() {
    const ids = state.girls.map(g => g.id);
    const keep = state.session.filter(id => ids.includes(id));
    const rest = shuffle(ids.filter(id => !keep.includes(id)));
    state.session = [...keep, ...rest].slice(0, Math.min(ids.length, 5 + rand(3)));
  }

  function renderStrip() {
    const strip = $id('girls-strip'), add = $id('strip-add'), tpl = $id('tpl-avatar');
    $$('.avatar:not(.add-avatar)', strip).forEach(n => n.remove());
    const frag = document.createDocumentFragment();
    state.girls.forEach(g => {
      const n = tpl.content.firstElementChild.cloneNode(true);
      n.dataset.id = g.id;
      n.querySelector('img').src = g.thumb;
      n.querySelector('.avatar-name').textContent = g.name;
      if (!state.session.includes(g.id)) n.querySelector('.online-dot').remove();
      if (g.pulse) n.classList.add('pulse-hint');
      frag.append(n);
    });
    add.after(frag);
    add.classList.toggle('pulse-hint', !state.girls.length);
    $id('onboarding').classList.toggle('hide', state.girls.length > 0);
  }

  function renderFav() {
    const tpl = $id('tpl-fav-card'), frag = document.createDocumentFragment();
    state.girls.filter(g => g.fav).forEach(g => {
      const n = tpl.content.firstElementChild.cloneNode(true);
      n.dataset.id = g.id;
      n.querySelector('img').src = g.cover || g.thumb;
      n.querySelector('strong').textContent = g.name;
      n.querySelector('small').textContent = `${g.age} · ${g.status || 'онлайн'}`;
      frag.append(n);
    });
    $id('fav-grid').replaceChildren(frag);
  }

  function syncFav(g) {
    $id('card-fav').classList.toggle('fav-on', !!g.fav);
    $id('pc-fav').classList.toggle('fav-on', !!g.fav);
  }

  async function toggleFav() {
    const g = state.cur;
    if (!g) return;
    g.fav = !g.fav;
    await dbPut('girls', g);
    syncFav(g);
    renderFav();
    toast(g.fav ? `${g.name} добавлена в избранное 💗` : `${g.name} убрана из избранного`, 'ok');
  }

  /* ---------- 7. ИИ: промпты и запросы ---------- */
  function sysPrompt(g, group) {
    const long = settings.size === 'long';
    return `Ты — ${g.name}, ${g.age} лет, виртуальный персонаж приложения (все персонажи совершеннолетние).\n` +
      `Характер и манера речи: ${g.prompt || 'дружелюбная и игривая'}.\n` +
      (group ? 'Ты в общем чате с другими девушками и игроком. Пиши только от своего имени, без префикса с именем. '
             : 'Ты общаешься с игроком наедине. ') +
      (long ? 'Пиши подробно в ролевом стиле: 3–6 предложений, действия и эмоции в *звёздочках*. '
            : 'Пиши коротко, как в мессенджере: 1–2 фразы, можно эмодзи. ') +
      'Отвечай по-русски и не выходи из образа.';
  }

  function endpoint() {
    const u = (settings.url || DEFAULTS.url).trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(u)) return u;
    if (/openrouter\.ai$/.test(u)) return `${u}/api/v1/chat/completions`;
    return /\/v\d+$/.test(u) ? `${u}/chat/completions` : `${u}/v1/chat/completions`;
  }

  async function aiReply(g, messages) {
    if (!settings.key) {
      if (!state.noKeyShown) { state.noKeyShown = true; toast('Укажите API-ключ в настройках — пока отвечаю заготовками', 'err'); }
      return CANNED[rand(CANNED.length)];
    }
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` };
      if (/openrouter\.ai/.test(settings.url)) { headers['HTTP-Referer'] = location.origin || 'https://localhost'; headers['X-Title'] = 'VIP Lounge'; }
      const res = await fetch(endpoint(), {
        method: 'POST', headers, signal: ctl.signal,
        body: JSON.stringify({ model: settings.model, messages, temperature: .9, max_tokens: settings.size === 'long' ? 450 : 160 })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      let text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      text = (text || '').trim();
      if (!text) throw new Error('пустой ответ');
      if (text.toLowerCase().startsWith(`${g.name.toLowerCase()}:`)) text = text.slice(g.name.length + 1).trim();
      return text;
    } catch (err) {
      toast(`Ошибка API: ${err.name === 'AbortError' ? 'таймаут' : err.message}`, 'err');
      return CANNED[rand(CANNED.length)];
    } finally { clearTimeout(timer); }
  }

  /* ---------- 8. Сообщения: рендер, хранение, реакции ---------- */
  function renderMsg(rec, feed) {
    const n = $id('tpl-msg').content.firstElementChild.cloneNode(true), mine = rec.who === 'me', g = G(rec.who);
    n.dataset.id = rec.id;
    n.classList.toggle('mine', mine);
    n.classList.toggle('liked', !!rec.liked);
    if (g) n.querySelector('.msg-ava').src = g.thumb;
    n.querySelector('.msg-name').textContent = mine ? 'Вы' : (g ? g.name : rec.name || '');
    n.querySelector('.msg-text').textContent = rec.text;
    feed.append(n);
    while (feed.children.length > FEED_LIMIT) feed.firstElementChild.remove();
    feed.scrollTop = feed.scrollHeight;
  }

  async function addMsg(kind, rec) {
    rec.ts = Date.now();
    if (kind === 'group') { state.tail.push(rec); if (state.tail.length > 30) state.tail.shift(); }
    rec.id = await dbAdd(kind === 'group' ? 'groupChat' : 'privateChats', rec);
    if (kind === 'group') renderMsg(rec, $id('feed'));
    else if (state.cur && state.cur.id === rec.girlId) renderMsg(rec, $id('pc-feed'));
    return rec;
  }

  async function reloadGroupFeed() {
    const all = await dbAll('groupChat');
    if (all.length > 400) {
      const tx = db.transaction('groupChat', 'readwrite');
      all.splice(0, all.length - 300).forEach(m => tx.objectStore('groupChat').delete(m.id));
      await txDone(tx);
    }
    state.tail = all.slice(-30);
    const feed = $id('feed');
    feed.replaceChildren();
    all.slice(-80).forEach(m => renderMsg(m, feed));
  }

  function floatHearts(x, y) {
    const layer = $id('hearts-layer');
    for (let i = 0; i < 3; i++) {
      const h = document.createElement('div');
      h.className = 'float-heart';
      h.innerHTML = '<svg class="ic"><use href="#i-heart"/></svg>';
      h.style.cssText = `left:${x + rand(40) - 20}px;top:${y - rand(20)}px;--x:${rand(70) - 35}px;--r:${rand(50) - 25}deg;animation-delay:${i * 90}ms`;
      h.addEventListener('animationend', () => h.remove());
      layer.append(h);
    }
  }

  async function toggleLike(node, storeName, x, y) {
    const rec = await dbGet(storeName, Number(node.dataset.id));
    if (!rec) return;
    rec.liked = !rec.liked;
    await dbPut(storeName, rec);
    node.classList.toggle('liked', rec.liked);
    buzz();
    if (rec.liked) floatHearts(x, y);
  }

  function bindDoubleTap(feed, storeName) {
    let last = { t: 0, id: null, x: 0, y: 0 };
    feed.addEventListener('pointerup', e => {
      const m = e.target.closest('.msg');
      if (!m) return;
      const now = performance.now();
      if (last.id === m.dataset.id && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
        last = { t: 0, id: null, x: 0, y: 0 };
        toggleLike(m, storeName, e.clientX, e.clientY);
      } else last = { t: now, id: m.dataset.id, x: e.clientX, y: e.clientY };
    });
  }

  /* ---------- 9. Общий чат: ответы, «Оживить» ---------- */
  const setTyping = name => {
    $id('live-line').hidden = !name;
    if (name) $id('live-text').textContent = `${name} печатает...`;
  };

  async function groupReply(g, instruction) {
    setTyping(g.name);
    const log = state.tail.slice(-14).map(m => `${m.who === 'me' ? 'Игрок' : m.name}: ${m.text}`).join('\n') || '(чат пока пуст)';
    const messages = [
      { role: 'system', content: sysPrompt(g, true) },
      { role: 'user', content: `Последние сообщения чата:\n${log}\n\n${instruction}` }
    ];
    try {
      const [text] = await Promise.all([aiReply(g, messages), sleep(2000 + rand(2000))]);
      await addMsg('group', { who: g.id, name: g.name, text });
    } finally { setTyping(null); }
  }

  function sendGroup(text) {
    addMsg('group', { who: 'me', name: 'Вы', text });
    const low = text.toLowerCase();
    const named = state.session.map(G).filter(g => g && low.includes(g.name.toLowerCase()));
    const who = named.length ? named.slice(0, 2) : shuffle(state.session).slice(0, 1 + rand(2)).map(G);
    state.queue = state.queue.then(async () => {
      for (const g of who) await groupReply(g, `Игрок только что написал в чат. Ответь ему как ${g.name}.`);
    }).catch(console.error);
  }

  function aliveChat() {
    const gs = shuffle(state.session).slice(0, 2 + rand(2)).map(G).filter(Boolean);
    if (gs.length < 2) return toast('Для живого диалога нужно хотя бы две девушки', 'err');
    const btn = $id('btn-alive'), names = gs.map(g => g.name).join(', ');
    btn.classList.add('busy');
    state.queue = state.queue.then(async () => {
      for (const g of gs) await groupReply(g, `Игрок молчит. Продолжи разговор с другими девушками (${names}) как ${g.name}: обратись к кому-то по имени или поддержи тему.`);
    }).catch(console.error).finally(() => btn.classList.remove('busy'));
  }

  /* ---------- 10. Дейтинг-карточка и «живое фото» ---------- */
  function openCard(id) {
    const g = G(id);
    if (!g) return;
    state.cur = g;
    if (g.pulse) {
      g.pulse = false;
      dbPut('girls', g);
      const av = $(`.avatar[data-id="${id}"]`);
      if (av) av.classList.remove('pulse-hint');
    }
    $id('card-name').textContent = g.name;
    $id('card-age').textContent = g.age;
    $id('sheet-name').textContent = g.name;
    $id('sheet-status').textContent = g.status || 'Онлайн';
    $id('sheet-desc').textContent = g.prompt || 'Загадочная особа без описания.';
    $id('hold-hint').classList.toggle('gone', state.holdSeen);
    syncFav(g);
    buildGallery(g);
    buildBars(g);
    show('card');
    showMedia(0);
  }

  function buildBars(g) {
    const frag = document.createDocumentFragment();
    if (g.media.length > 1) g.media.forEach(() => frag.append(document.createElement('i')));
    $id('story-bars').replaceChildren(frag);
  }

  function markActive(i) {
    const bars = $id('story-bars');
    [...bars.children].forEach((b, j) => { b.classList.remove('done', 'cur'); if (j < i) b.classList.add('done'); });
    const cur = bars.children[i];
    if (cur) { void cur.offsetWidth; cur.classList.add('cur'); }
    $$('#sheet-gallery .thumb').forEach((t, j) => t.classList.toggle('active', j === i));
  }

  function releaseMedia() {
    const v = $id('card-video');
    v.pause(); v.removeAttribute('src'); v.load();
    $id('card-photo').removeAttribute('src');
    if (state.mediaURL) { URL.revokeObjectURL(state.mediaURL); state.mediaURL = null; }
  }

  async function showMedia(i) {
    const g = state.cur, img = $id('card-photo'), vid = $id('card-video'), tk = ++state.token;
    if (!g) return;
    const n = g.media.length;
    if (!n) {
      releaseMedia();
      vid.hidden = true; img.hidden = false;
      img.src = gradientURL(g.hue, g.name, 540, 720);
      return;
    }
    i = (i + n) % n;
    state.idx = i;
    markActive(i);
    const rec = await dbGet('media', g.media[i].id);
    if (tk !== state.token || !rec) return;
    const url = URL.createObjectURL(rec.blob), old = state.mediaURL;
    state.mediaURL = url;
    if (rec.type === 'video') {
      img.hidden = true; img.removeAttribute('src');
      vid.hidden = false; vid.poster = g.media[i].thumb; vid.src = url; vid.load();
    } else {
      vid.pause(); vid.hidden = true; vid.removeAttribute('src'); vid.load();
      img.hidden = false; img.src = url;
    }
    if (old) URL.revokeObjectURL(old);
  }

  function leaveCard() {
    state.token++;
    endHold();
    closeSheet();
    releaseMedia();
    show('main');
  }

  function tilt(x, y) {
    const m = $id('card-media'), r = m.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (x - r.left) / r.width)), ny = Math.min(1, Math.max(0, (y - r.top) / r.height));
    m.style.setProperty('--tx', ((nx - .5) * 14).toFixed(2));
    m.style.setProperty('--ty', (-(ny - .5) * 14).toFixed(2));
  }
  
  function resetTilt() {
    const m = $id('card-media');
    m.style.setProperty('--tx', '0');
    m.style.setProperty('--ty', '0');
  }
  
  function toggleCleanView() {
    state.immersive = !state.immersive;
    $id('card-media').classList.toggle('immersive', state.immersive);
    const v = $id('card-video');
    if (!v.hidden) {
      if (state.immersive) { v.muted = false; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); }
      else { v.pause(); v.muted = true; }
    }
  }
  
  function endHold() {
    state.immersive = false;
    const m = $id('card-media'), v = $id('card-video');
    m.classList.remove('immersive', 'zoomed');
    m.style.setProperty('--zoom', '1');
    resetTilt();
    v.pause(); v.muted = true;
  }
  
  function togglePhotoZoom(x, y) {
    const m = $id('card-media'), r = m.getBoundingClientRect();
    const zoomed = m.classList.toggle('zoomed');
    resetTilt();
    if (zoomed) {
      const ox = Math.min(100, Math.max(0, ((x - r.left) / r.width) * 100)).toFixed(1);
      const oy = Math.min(100, Math.max(0, ((y - r.top) / r.height) * 100)).toFixed(1);
      m.style.setProperty('--ox', `${ox}%`);
      m.style.setProperty('--oy', `${oy}%`);
      m.style.setProperty('--zoom', '2.1');
    } else {
      m.style.setProperty('--zoom', '1');
    }
    buzz();
  }
  
  function bindCardGestures() {
    const m = $id('card-media');
    let start = null, tapTimer = 0, lastTap = 0, raf = 0;
  
    m.addEventListener('contextmenu', e => e.preventDefault());
  
    m.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      start = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY };
    });
  
    m.addEventListener('pointermove', e => {
      if (!start || m.classList.contains('zoomed')) return;
      start.lx = e.clientX; start.ly = e.clientY;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (start) tilt(start.lx, start.ly); });
    });
  
    m.addEventListener('pointerup', e => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      start = null;
      resetTilt();
  
      if (dy < -60 && Math.abs(dx) < 90) { clearTimeout(tapTimer); return openSheet(); }
      if (Math.abs(dx) > 55 && Math.abs(dy) < 80) {
        clearTimeout(tapTimer);
        m.classList.remove('zoomed'); m.style.setProperty('--zoom', '1');
        return showMedia(dx > 0 ? state.idx - 1 : state.idx + 1);
      }
      if (Math.hypot(dx, dy) > 15) return;
  
      const now = performance.now();
      const x = e.clientX, y = e.clientY;
  
      if (now - lastTap < 280) {
        clearTimeout(tapTimer);
        lastTap = 0;
        return togglePhotoZoom(x, y);
      }
  
      lastTap = now;
      tapTimer = setTimeout(() => {
        lastTap = 0;
        const r = m.getBoundingClientRect(), relX = (x - r.left) / r.width;
        if (m.classList.contains('zoomed')) return togglePhotoZoom(x, y);
        if (relX < 0.22) showMedia(state.idx - 1);
        else if (relX > 0.78) showMedia(state.idx + 1);
        else toggleCleanView();
      }, 240);
    });
  
    m.addEventListener('pointercancel', () => { start = null; resetTilt(); });
  
    $id('story-bars').addEventListener('animationend', e => {
      if (!state.immersive && !m.classList.contains('zoomed') && e.target.classList.contains('cur')) {
        showMedia(state.idx + 1);
      }
    });
  }
  
  /* ---------- 11. Нижняя шторка анкеты ---------- */
  function buildGallery(g) {
    const tpl = $id('tpl-thumb'), frag = document.createDocumentFragment();
    (g.media.length ? g.media.map(m => m.thumb) : [g.thumb]).forEach((src, i) => {
      const n = tpl.content.firstElementChild.cloneNode(true);
      n.dataset.index = i;
      n.querySelector('img').src = src;
      frag.append(n);
    });
    $id('sheet-gallery').replaceChildren(frag);
  }

  function openSheet() {
    $id('sheet').classList.add('open');
    $id('sheet').setAttribute('aria-hidden', 'false');
    $id('sheet-backdrop').classList.add('open');
  }

  function closeSheet() {
    $id('sheet').classList.remove('open');
    $id('sheet').setAttribute('aria-hidden', 'true');
    $id('sheet-backdrop').classList.remove('open');
  }

  function bindSheetDrag() {
    const grip = $id('sheet-grip'), sheet = $id('sheet');
    let drag = null;
    grip.addEventListener('pointerdown', e => {
      drag = { y: e.clientY, dy: 0 };
      sheet.classList.add('dragging');
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', e => {
      if (!drag) return;
      drag.dy = Math.max(0, e.clientY - drag.y);
      sheet.style.transform = `translate3d(0,${drag.dy}px,0)`;
    });
    const end = () => {
      if (!drag) return;
      const close = drag.dy > 90 || drag.dy < 6;
      drag = null;
      sheet.classList.remove('dragging');
      sheet.style.transform = '';
      if (close) closeSheet();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  /* ---------- 12. Анкета: создание, редактирование, удаление ---------- */
  function renderPreviews() {
    const tpl = $id('tpl-thumb'), frag = document.createDocumentFragment();
    state.formMedia.forEach((m, i) => {
      const n = tpl.content.firstElementChild.cloneNode(true);
      n.dataset.index = i;
      n.querySelector('img').src = m.thumb;
      frag.append(n);
    });
    $id('f-previews').replaceChildren(frag);
  }

  function openForm(id) {
    const g = id ? G(id) : null;
    state.editId = g ? g.id : null;
    state.formRemoved = [];
    state.formMedia = g ? g.media.map(m => ({ ...m })) : [];
    $id('girl-modal-title').textContent = g ? 'Редактирование анкеты' : 'Новая анкета';
    $id('f-name').value = g ? g.name : '';
    $id('f-age').value = g ? g.age : 21;
    $id('f-status').value = g ? g.status || '' : '';
    $id('f-prompt').value = g ? g.prompt || '' : '';
    renderPreviews();
    openModal('modal-girl');
  }

  async function addFiles(files) {
    for (const f of files) {
      const type = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : null;
      if (!type) { toast(`Формат не поддерживается: ${f.name}`, 'err'); continue; }
      try {
        state.formMedia.push({ type, blob: f, thumb: await makeThumb(f, type === 'video') });
        renderPreviews();
      } catch { toast(`Не удалось обработать файл ${f.name}`, 'err'); }
    }
  }

  async function saveGirl(e) {
    e.preventDefault();
    const name = $id('f-name').value.trim(), age = Number($id('f-age').value);
    if (!name) return toast('Введите имя', 'err');
    if (!(age >= 18)) return toast('Возраст должен быть 18+', 'err');
    const old = state.editId ? G(state.editId) : null;
    const g = old ? { ...old } : { id: `g${Date.now().toString(36)}${rand(1e4)}`, created: Date.now(), hue: rand(360), fav: false, pulse: false };
    Object.assign(g, { name, age, status: $id('f-status').value.trim(), prompt: $id('f-prompt').value.trim() });
    try {
      g.media = [];
      for (const m of state.formMedia) {
        const id = m.id !== undefined ? m.id : await dbAdd('media', { girlId: g.id, type: m.type, blob: m.blob });
        g.media.push({ id, type: m.type, thumb: m.thumb });
      }
      for (const id of state.formRemoved) await dbDel('media', id);
      const first = state.formMedia[0];
      g.thumb = first ? first.thumb : gradientURL(g.hue, name, THUMB, THUMB);
      if (first) {
        const blob = first.blob || (await dbGet('media', first.id)).blob;
        g.cover = await makeThumb(blob, first.type === 'video', 720, 960);
      } else g.cover = gradientURL(g.hue, name, 360, 480);
      await dbPut('girls', g);
    } catch (err) { return toast(`Ошибка сохранения: ${err.message}`, 'err'); }
    if (old) state.girls[state.girls.indexOf(old)] = g; else state.girls.push(g);
    refreshSession(); renderStrip(); renderFav();
    closeModal('modal-girl');
    toast('Анкета сохранена', 'ok');
    if (!old) await addMsg('group', { who: g.id, name: g.name, text: `Привет всем! Я ${g.name}, рада быть здесь ✨` });
    else if (state.cur && state.cur.id === g.id) openCard(g.id);
  }

  async function deleteGirl() {
    const g = state.cur;
    if (!g) return;
    closeSheet();
    if (!(await askConfirm(`Удалить ${g.name}?`, 'Анкета, медиафайлы и переписка будут удалены навсегда.'))) return;
    leaveCard();
    try {
      await dbDelByGirl('media', g.id);
      await dbDelByGirl('privateChats', g.id);
      await dbDel('girls', g.id);
      const tx = db.transaction('groupChat', 'readwrite');
      (await dbAll('groupChat')).filter(m => m.who === g.id).forEach(m => tx.objectStore('groupChat').delete(m.id));
      await txDone(tx);
    } catch (err) { return toast(`Ошибка удаления: ${err.message}`, 'err'); }
    state.girls = state.girls.filter(x => x.id !== g.id);
    state.cur = null;
    refreshSession(); renderStrip(); renderFav();
    await reloadGroupFeed();
    toast(`${g.name} удалена`, 'ok');
  }

  /* ---------- 13. Приватный чат ---------- */
  async function openPrivate() {
    const g = state.cur;
    if (!g) return;
    $id('pc-bg').style.backgroundImage = `url(${g.thumb})`;
    $id('pc-avatar').src = g.thumb;
    $id('pc-name').textContent = g.name;
    $id('pc-status').textContent = 'онлайн';
    $id('pc-typing').hidden = true;
    syncFav(g);
    const feed = $id('pc-feed');
    feed.replaceChildren();
    (await dbByGirl('privateChats', g.id)).slice(-80).forEach(m => renderMsg(m, feed));
    show('private');
    feed.scrollTop = feed.scrollHeight;
  }

  async function sendPrivate(text) {
    const g = state.cur;
    if (!g) return;
    await addMsg('private', { girlId: g.id, who: 'me', text });
    $id('pc-typing').hidden = false;
    try {
      const hist = (await dbByGirl('privateChats', g.id)).slice(-20)
        .map(m => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.text }));
      const messages = [{ role: 'system', content: sysPrompt(g, false) }, ...hist];
      const [reply] = await Promise.all([aiReply(g, messages), sleep(1200 + rand(1600))]);
      await addMsg('private', { girlId: g.id, who: g.id, text: reply });
    } finally { $id('pc-typing').hidden = true; }
  }

  async function clearPrivate() {
    const g = state.cur;
    if (!g) return;
    if (!(await askConfirm('Очистить диалог?', `Вся личная переписка с ${g.name} будет удалена.`))) return;
    await dbDelByGirl('privateChats', g.id);
    $id('pc-feed').replaceChildren();
    toast('Диалог очищен', 'ok');
  }

  /* ---------- 14. Онбординг ---------- */
  async function seedIfEmpty() {
    if (state.girls.length || (await dbGet('settings', 'onboarded'))) return;
    for (const [i, s] of STARTERS.entries()) {
      const g = {
        ...s, media: [], fav: false, pulse: i === 0, created: Date.now() + i,
        thumb: gradientURL(s.hue, s.name, THUMB, THUMB), cover: gradientURL(s.hue, s.name, 360, 480)
      };
      await dbPut('girls', g);
      state.girls.push(g);
    }
    await dbPut('settings', { key: 'onboarded', value: true });
    await dbAdd('groupChat', {
      who: STARTERS[0].id, name: STARTERS[0].name, ts: Date.now(),
      text: 'Привет-привет! 💕 Я Алиса. Нажми на моё фото сверху — покажу анкету. А если на карточке зажмёшь экран пальцем, фотография оживёт...'
    });
  }

  /* ---------- 15. Привязка событий ---------- */
  function bindEvents() {
    document.addEventListener('click', e => {
      if (e.target.closest('button, .btn, .fav-card, label.upload-btn')) buzz();
    }, true);

    $$('.modal').forEach(m => m.addEventListener('click', e => {
      if (m.id === 'modal-confirm') return;
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m.id);
    }));
    $id('confirm-yes').addEventListener('click', () => answerConfirm(true));
    $id('confirm-no').addEventListener('click', () => answerConfirm(false));

    $('.tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
    $id('btn-add').addEventListener('click', () => openForm(null));
    $id('strip-add').addEventListener('click', () => openForm(null));
    $id('btn-settings').addEventListener('click', openSettings);
    $id('settings-form').addEventListener('submit', saveSettingsForm);
    // --- Экспорт и импорт базы данных ---
    const blobToBase64 = b => new Promise(res => {
      const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b);
    });
    const base64ToBlob = async s => (await fetch(s)).blob();
    
    $id('btn-export-db').addEventListener('click', async () => {
      toast('Собираю архив базы...', 'ok');
      try {
        const mediaRaw = await dbAll('media');
        const media = await Promise.all(mediaRaw.map(async m => ({ ...m, blob: await blobToBase64(m.blob) })));
        const dump = {
          v: 1, settings,
          girls: await dbAll('girls'),
          groupChat: await dbAll('groupChat'),
          privateChats: await dbAll('privateChats'),
          media
        };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(dump)], { type: 'application/json' }));
        a.download = `vip-lounge-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast('Резервная копия скачана!', 'ok');
      } catch (err) { toast('Ошибка экспорта: ' + err.message, 'err'); }
    });
    
    $id('btn-import-db').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!(await askConfirm('Восстановить базу?', 'Текущие анкеты и чаты будут заменены данными из файла.'))) return;
      toast('Восстанавливаю данные...', 'ok');
      try {
        const dump = JSON.parse(await file.text());
        for (const s of ['girls', 'media', 'groupChat', 'privateChats']) {
          await txDone(db.transaction(s, 'readwrite').objectStore(s).clear());
        }
        for (const g of (dump.girls || [])) await dbPut('girls', g);
        for (const c of (dump.groupChat || [])) await dbPut('groupChat', c);
        for (const p of (dump.privateChats || [])) await dbPut('privateChats', p);
        for (const m of (dump.media || [])) {
          await dbPut('media', { ...m, blob: await base64ToBlob(m.blob) });
        }
        if (dump.settings) { settings = { ...DEFAULTS, ...dump.settings }; persistSettings(); }
        state.girls = (await dbAll('girls')).sort((a, b) => a.created - b.created);
        refreshSession(); renderStrip(); renderFav();
        await reloadGroupFeed();
        closeModal('modal-settings');
        toast('База успешно восстановлена!', 'ok');
      } catch (err) { toast('Ошибка файла: ' + err.message, 'err'); }
    });
    $id('girls-strip').addEventListener('click', e => {
      const a = e.target.closest('.avatar:not(.add-avatar)');
      if (a) openCard(a.dataset.id);
    });
    $id('fav-grid').addEventListener('click', e => {
      const c = e.target.closest('.fav-card');
      if (c) openCard(c.dataset.id);
    });

    $id('chat-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = $id('chat-input'), text = input.value.trim();
      if (!text) return;
      if (!state.girls.length) return toast('Сначала создайте анкету', 'err');
      input.value = '';
      sendGroup(text);
    });
    $id('btn-alive').addEventListener('click', aliveChat);
    bindDoubleTap($id('feed'), 'groupChat');
    bindDoubleTap($id('pc-feed'), 'privateChats');

    $id('card-back').addEventListener('click', leaveCard);
    $id('card-fav').addEventListener('click', toggleFav);
    $id('card-cta').addEventListener('click', openPrivate);
    $id('sheet-handle').addEventListener('click', openSheet);
    $id('sheet-backdrop').addEventListener('click', closeSheet);
    $id('btn-edit').addEventListener('click', () => { closeSheet(); if (state.cur) openForm(state.cur.id); });
    $id('btn-delete').addEventListener('click', deleteGirl);
    $id('sheet-gallery').addEventListener('click', e => {
      const t = e.target.closest('.thumb');
      if (!t || !state.cur || !state.cur.media.length) return;
      showMedia(Number(t.dataset.index));
      closeSheet();
    });
    bindCardGestures();
    bindSheetDrag();

    $id('pc-back').addEventListener('click', () => show('card'));
    $id('pc-fav').addEventListener('click', toggleFav);
    $id('pc-clear').addEventListener('click', clearPrivate);
    $id('pc-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = $id('pc-input'), text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendPrivate(text).catch(console.error);
    });

    $id('girl-form').addEventListener('submit', saveGirl);
    $id('f-files').addEventListener('change', async e => {
      const files = [...e.target.files];
      e.target.value = '';
      await addFiles(files);
    });
    $id('f-previews').addEventListener('click', e => {
      const del = e.target.closest('.thumb-del');
      if (!del) return;
      const i = Number(del.closest('.thumb').dataset.index), [m] = state.formMedia.splice(i, 1);
      if (m && m.id !== undefined) state.formRemoved.push(m.id);
      renderPreviews();
    });

    if (window.visualViewport) window.visualViewport.addEventListener('resize', setViewport);
    window.addEventListener('resize', setViewport);
  }

  /* ---------- 16. Запуск ---------- */
  async function init() {
    setViewport();
    settings = loadSettings();
    db = await openDB();
    state.girls = (await dbAll('girls')).sort((a, b) => a.created - b.created);
    await seedIfEmpty();
    refreshSession();
    renderStrip();
    renderFav();
    await reloadGroupFeed();
    bindEvents();
    show('main');
    }

  init().catch(err => {
    console.error(err);
    toast('Не удалось открыть базу данных', 'err');
  });
})();