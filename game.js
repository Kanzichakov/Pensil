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

  const THUMB = 320, COVER_W = 1080, COVER_H = 1440, IMG_Q = .95, FEED_LIMIT = 120, SETTINGS_KEY = 'vip.settings', HOLD_KEY = 'vip.holdSeen';
  const DEFAULTS = { url: 'https://openrouter.ai', key: '', model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', size: 'short', persona: '', ttsMode: 'neural', ttsUrl: 'https://vip-tts.buntar428.workers.dev' };
  const state = {
    girls: [], session: [], tail: [], cur: null, idx: 0, token: 0, immersive: false, pan: { x: 0, y: 0 }, fx: .5, fy: .5,
    formMedia: [], formRemoved: [], editId: null, queue: Promise.resolve(), noKeyShown: false,
    holdSeen: localStorage.getItem(HOLD_KEY) === '1'
  };
  let db, settings = { ...DEFAULTS }, confirmResolve = null, lastErr = { m: '', t: 0 }, ignorePop = 0;
  const G = id => state.girls.find(g => g.id === id);

  const STARTERS = [
    { id: 'seed-alisa', name: 'Алиса', age: 22, hue: 340, status: 'Скучаю по вечерним разговорам',
      prompt: 'Нежная, игривая и чуть застенчивая. Любит дразнить комплиментами и называет собеседника «солнышко». Говорит тепло, с эмодзи.',
      voice: 'svetlana', pitch: 1.1, rate: 1.05 },
    { id: 'seed-mira', name: 'Мира', age: 25, hue: 275, status: 'Ночная пташка · кофе и джаз',
      prompt: 'Загадочная и ироничная, говорит с лёгкой хитринкой. Обожает ночные беседы, джаз и философию. Отвечает лаконично, с подтекстом.',
      voice: 'elena', pitch: 0.9, rate: 0.9 },
    { id: 'seed-lika', name: 'Лика', age: 20, hue: 25, status: 'Всегда в движении ⚡',
      prompt: 'Энергичная, смешная и прямолинейная. Занимается танцами, любит подкалывать и задавать неожиданные вопросы. Пишет быстро и эмоционально.',
      voice: 'dariya', pitch: 1.2, rate: 1.1 }
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
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (raw && raw.model === 'anthropic/claude-sonnet-4.5') {   // миграция: старая модель по умолчанию → новая
        raw.model = DEFAULTS.model;
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(raw)); } catch { /* квота */ }
      }
      const o = { ...DEFAULTS, ...raw };
      if (!o.ttsUrl) o.ttsUrl = DEFAULTS.ttsUrl;
      return o;
    }
    catch { return { ...DEFAULTS }; }
  };
  const persistSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* квота */ } };

  function openSettings() {
    $id('s-url').value = settings.url;
    $id('s-key').value = settings.key;
    $id('s-model').value = settings.model;
    $('#s-persona').value = settings.persona || '';
    $(`input[name="reply-size"][value="${settings.size}"]`).checked = true;
    $(`input[name="tts-mode"][value="${settings.ttsMode === 'browser' ? 'browser' : 'neural'}"]`).checked = true;
    $id('s-tts-url').value = settings.ttsUrl || '';
    openModal('modal-settings');
  }

  function saveSettingsForm(e) {
    e.preventDefault();
    settings = {
      url: $id('s-url').value.trim() || DEFAULTS.url,
      key: $id('s-key').value.trim(),
      model: $id('s-model').value.trim() || DEFAULTS.model,
      size: $('input[name="reply-size"]:checked').value,
      persona: $('#s-persona').value.trim(),
      ttsMode: $('input[name="tts-mode"]:checked').value,
      ttsUrl: $id('s-tts-url').value.trim() || DEFAULTS.ttsUrl
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
  const closeModal = id => { stopSpeech(); const m = $id(id); m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); };

  function askConfirm(title, text) {
    $id('confirm-title').textContent = title;
    $id('confirm-text').textContent = text;
    if (confirmResolve) confirmResolve(false);
    openModal('modal-confirm');
    return new Promise(res => { confirmResolve = res; });
  }

  function answerConfirm(value) {
    closeModal('modal-confirm');
    if (confirmResolve) confirmResolve(value);
    confirmResolve = null;
  }

  /* ---------- Озвучка: нейросетевой женский TTS + резервный speechSynthesis ---------- */
  const NEURAL_VOICES = {
    svetlana: { id: 'ru-RU-SvetlanaNeural', label: 'Светлана', dp: 0, dr: 0, pref: /milena|svetlana|irina|tatiana|natalia/i },
    dariya:   { id: 'ru-RU-DariyaNeural',   label: 'Дарья',    dp: 0, dr: 0, pref: /alena|katya|darina|anna|maria|ruf/i },
    elena:    { id: 'ru-RU-ElenaNeural',    label: 'Елена',    dp: 0, dr: 0, pref: /irina|olga|elena|ruc|tatiana/i }
  };
  const TTS_ENDPOINTS = ['https://vip-tts.buntar428.workers.dev'];   // встроенные прокси (если есть); основной адрес задаётся в настройках
  const VOICE_PRESETS = { 'seed-alisa': { voice: 'svetlana', pitch: 1.1, rate: 1.05 }, 'seed-mira': { voice: 'elena', pitch: 0.9, rate: 0.9 }, 'seed-lika': { voice: 'dariya', pitch: 1.2, rate: 1.1 } };
  const FEMALE_RE = /milena|alena|irina|svetlana|katya|tatiana|natalia|olga|elena|anna|maria|darina|female|жен|ru-ru-x-ruf|ru-ru-x-ruc/i;
  const MALE_RE = /pavel|dmitry|maxim|aleksei|alexey|yuri|male|муж|ru-ru-x-rud|ru-ru-x-rue/i;
  const isMale = v => MALE_RE.test(`${v.name} ${v.voiceURI}`) && !/\bfemale\b/i.test(`${v.name} ${v.voiceURI}`);
  const isFemale = v => FEMALE_RE.test(`${v.name} ${v.voiceURI}`) && !isMale(v);
  const clampN = (x, a, b, d) => { x = Number(x); return Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : d; };

  let sysVoices = [], curSrc = null, audioCtx = null, speakTok = 0, neuralDownUntil = 0, voiceBtn = null;
  const ttsCache = new Map(), TTS_CACHE_MAX = 40;

  function loadSysVoices() {
    const ss = window.speechSynthesis;
    if (!ss) return;
    sysVoices = ss.getVoices().filter(v => /^ru/i.test(v.lang) || /русск|russian/i.test(v.name));
    fillVoiceSelect();
  }
  function fillVoiceSelect() {
    const sel = $id('f-voice');
    if (!sel) return;
    const keep = sel.value;
    $$('optgroup', sel).forEach(o => o.remove());
    const fem = sysVoices.filter(isFemale);
    if (fem.length) {
      const og = document.createElement('optgroup');
      og.label = 'Системные женские голоса';
      fem.forEach(v => { const o = document.createElement('option'); o.value = `sys:${v.voiceURI || v.name}`; o.textContent = v.name; og.append(o); });
      sel.append(og);
    }
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  }

  /* Параметры голоса девушки: пресет для стартовых анкет, «авто» — по характеру */
  function voiceCfg(g) {
    const p = (g && VOICE_PRESETS[g.id]) || {};
    let voice = (g && g.voice) || p.voice || 'auto';
    const pitch = clampN(g && g.pitch != null ? g.pitch : p.pitch, 0.85, 1.25, 1);
    const rate = clampN(g && g.rate != null ? g.rate : p.rate, 0.85, 1.2, 1);
    if (voice === 'auto') {
      const t = `${g ? g.prompt || '' : ''}`.toLowerCase();
      if (/энергич|игрив|смешн|весёл|веселя|звонк|озорн|танц/.test(t)) voice = 'dariya';
      else if (/спокой|загадоч|ирони|бархат|ночн|философ|строг|взросл/.test(t)) voice = 'elena';
      else if (/нежн|тепл|мягк|застенч|ласков/.test(t)) voice = 'svetlana';
      else { let h = 0; for (const ch of String(g ? g.id : 'x')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; voice = ['svetlana', 'dariya', 'elena'][h % 3]; }
    }
    return { voice, pitch, rate };
  }

  /* Очистка текста: действия *в звёздочках*, эмодзи, разметка */
  function cleanForSpeech(text) {
    return String(text || '')
      .replace(/\*[^*]*\*/g, ' ')
      .replace(/[*_~`#>]+/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f\u20e3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu, ' ')
      .replace(/\s+([,.!?…])/g, '$1')
      .replace(/\s+/g, ' ').trim();
  }

  function setPlaying(btn, cls) {
    $$('.msg-speak.playing, .msg-speak.loading, .btn-voice.playing, .btn-voice.loading').forEach(b => b.classList.remove('playing', 'loading'));
    if (btn && cls) btn.classList.add(cls);
  }

  function stopSpeech() {
    speakTok++;
    if (curSrc) {
      const src = curSrc; curSrc = null;
      try { src.stop(); } catch { /* уже остановлен */ }   // onended сработает и освободит ожидающий playUrl
      try { src.disconnect(); } catch { /* */ }
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setPlaying(null);
    voiceBtn = null;
  }

  /* Web Audio: один общий AudioContext на всё приложение (webkitAudioContext для старых Safari) */
  function getAudioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('no-webaudio');
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC();
    return audioCtx;
  }
  const decodeAudio = (ctx, buf) => new Promise((res, rej) => {
    const p = ctx.decodeAudioData(buf, res, rej);   // колбэки — для старых браузеров, промис — для новых
    if (p && typeof p.catch === 'function') p.catch(rej);
  });

  /* Нейросетевой TTS: OpenAI-совместимый /v1/audio/speech, в кэше на время сессии лежит сам MP3 (ArrayBuffer).
     Тон и скорость применяются на клиенте через playbackRate, поэтому в ключе кэша их нет. */
  async function fetchNeural(text, cfg) {
    const nv = NEURAL_VOICES[cfg.voice] || NEURAL_VOICES.svetlana;
    const key = `${nv.id}|${text}`;
    if (ttsCache.has(key)) return ttsCache.get(key);
    const bases = [...new Set([settings.ttsUrl, ...TTS_ENDPOINTS].map(s => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean))];
    if (!bases.length || !navigator.onLine) throw new Error('no-endpoint');
    // сервер отдаёт «нейтральный» голос: тон/скорость накладываются на клиенте (playbackRate), чтобы не применять их дважды
    const body = JSON.stringify({
      model: 'tts-1', input: text, voice: nv.id, response_format: 'mp3', speed: 1, pitch: '+0Hz', rate: '+0%'
    });
    let lastE;
    for (const b of bases) {
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 9000);
      try {
        const r = await fetch(b === DEFAULTS.ttsUrl || /\/audio\/speech$/.test(b) ? b : `${b}/v1/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get('content-type') || '';
        if (ct && !/audio|octet|mpeg|wav/i.test(ct)) throw new Error('bad-audio');
        const buf = await r.arrayBuffer();
        if (!buf.byteLength) throw new Error('bad-audio');
        ttsCache.set(key, buf);
        if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
        return buf;
      } catch (e) { lastE = e; } finally { clearTimeout(tm); }
    }
    throw lastE || new Error('tts-fail');
  }

  /* Итоговая скорость воспроизведения (с учётом смещений пресета): мягкая формула, чтобы голос
     не пищал вверху и не тянулся внизу. playbackRate меняет и скорость, и высоту голоса.
     Диапазон узкий: 0.96–1.08, ползунки лишь слегка подстраивают живой голос. */
  function neuralPlaybackRate(cfg) {
    cfg = cfg || {};
    const nv = NEURAL_VOICES[cfg.voice] || { dp: 0, dr: 0 };
    const pitch = clampN((cfg.pitch != null ? cfg.pitch : 1) + nv.dp, 0.7, 1.4, 1);
    const rate = clampN((cfg.rate != null ? cfg.rate : 1) + nv.dr, 0.7, 1.4, 1);
    return clampN(1 + ((pitch - 1) * 0.15) + ((rate - 1) * 0.25), 0.96, 1.08, 1);
  }

  /* Воспроизведение MP3 через Web Audio: playbackRate у AudioBufferSourceNode меняет и скорость, и высоту голоса
     (на Android у HTMLAudioElement preservesPitch=false игнорируется) */
  async function playUrl(arrayBuffer, tok, btn, cfg) {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const audioBuf = await decodeAudio(ctx, arrayBuffer.slice(0));   // копия: decodeAudioData «съедает» переданный буфер
    if (tok !== speakTok) return;
    await new Promise(res => {
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.playbackRate.value = neuralPlaybackRate(cfg);
      src.connect(ctx.destination);
      curSrc = src;
      src.onended = () => {
        try { src.disconnect(); } catch { /* */ }
        if (curSrc === src) curSrc = null;
        if (tok === speakTok) { setPlaying(null); voiceBtn = null; }
        res();
      };
      src.start(0);
      setPlaying(btn, 'playing');
    });
  }

  /* Резервный голос браузера: только женские русские голоса */
  function pickSysVoice(cfg) {
    const all = (sysVoices.length ? sysVoices : (window.speechSynthesis ? window.speechSynthesis.getVoices() : [])).filter(v => /^ru/i.test(v.lang) || /русск|russian/i.test(v.name));
    const female = all.filter(isFemale);
    if (cfg.voice && cfg.voice.startsWith('sys:')) {
      const id = cfg.voice.slice(4), v = female.find(x => (x.voiceURI || x.name) === id);
      if (v) return { v, boost: 0 };
    }
    const nv = NEURAL_VOICES[cfg.voice];
    if (female.length) {
      const idx = Math.max(0, ['svetlana', 'dariya', 'elena'].indexOf(cfg.voice));
      return { v: (nv && female.find(x => nv.pref.test(`${x.name} ${x.voiceURI}`))) || female[idx % female.length], boost: 0 };
    }
    const neutral = all.filter(v => !isMale(v));   // неизвестный пол (напр. «Google русский») — не мужской
    if (neutral.length) return { v: neutral[0], boost: 0.05 };
    return { v: null, boost: 0.15 };   // только мужские голоса: системный по умолчанию, тон выше
  }

  function speakBrowser(text, cfg, tok, btn) {
    const ss = window.speechSynthesis;
    if (!ss) { setPlaying(null); return toast('Озвучка не поддерживается в этом браузере', 'err'); }
    ss.cancel();
    const nv = NEURAL_VOICES[cfg.voice] || { dp: 0, dr: 0 }, { v, boost } = pickSysVoice(cfg);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    if (v) { u.voice = v; u.lang = v.lang; }
    u.pitch = clampN(cfg.pitch + nv.dp + boost, 0.5, 2, 1.05);
    u.rate = clampN(cfg.rate + nv.dr, 0.5, 2, 1);
    u.onstart = () => { if (tok === speakTok) setPlaying(btn, 'playing'); };
    u.onend = u.onerror = () => { if (tok === speakTok) { setPlaying(null); voiceBtn = null; } };
    setPlaying(btn, 'playing');
    ss.speak(u);
  }

  async function speakText(btn, text, cfg) {
    if (btn && btn === voiceBtn) return stopSpeech();   // повторное нажатие — стоп
    stopSpeech();
    const clean = cleanForSpeech(text).slice(0, 1200);
    if (!clean) return toast('Нечего озвучивать', '');
    const tok = speakTok;
    voiceBtn = btn;
    try { const c = getAudioCtx(); if (c.state === 'suspended') c.resume().catch(() => {}); } catch { /* нет Web Audio — сработает откат */ }   // «разбудить» контекст прямо в жесте нажатия
    const useNeural = settings.ttsMode !== 'browser' && Date.now() > neuralDownUntil;
    if (useNeural) {
      setPlaying(btn, 'loading');
      try {
        const buf = await fetchNeural(clean, cfg);
        if (tok !== speakTok) return;
        await playUrl(buf, tok, btn, cfg);
        return;
      } catch (e) {
        if (tok !== speakTok) return;
        if (e && e.message !== 'no-endpoint') neuralDownUntil = Date.now() + 60000;   // не долбим недоступный сервер минуту
        console.warn('Нейро-TTS недоступен, откат на speechSynthesis:', e && e.message);
      }
    }
    if (tok !== speakTok) return;
    speakBrowser(clean, cfg, tok, btn);
  }

  const speakMsg = (btn, text, who) => speakText(btn, text, voiceCfg(G(who)));

  function readVoiceForm() {
    return { voice: $id('f-voice').value, pitch: clampN($id('f-pitch').value, 0.85, 1.25, 1), rate: clampN($id('f-rate').value, 0.85, 1.2, 1) };
  }
  function syncRangeUI() {
    [['f-pitch', 'f-pitch-out'], ['f-rate', 'f-rate-out']].forEach(([i, o]) => {
      const r = $id(i);
      $id(o).textContent = Number(r.value).toFixed(2);
      r.style.setProperty('--pct', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
    });
  }
  function testVoice() {
    const name = $id('f-name').value.trim() || 'новая знакомая';
    const cfg = readVoiceForm();
    if (cfg.voice === 'auto') cfg.voice = voiceCfg({ id: state.editId || 'x', prompt: $id('f-prompt').value }).voice;
    speakText($id('btn-voice-test'), `Привет! Меня зовут ${name}. Рада тебя слышать, давай немного поболтаем?`, cfg);
  }

  function show(name) {
    stopSpeech();
    if (name !== 'private') clearPrivateBg();
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
    document.body.dataset.screen = name;
  }

  const pushNav = s => { try { history.pushState({ s }, ''); } catch { /* file:// и т. п. */ } };
  const navBack = fallback => { if (history.state && history.state.s) history.back(); else fallback(); };

  function setTab(t) {
    stopSpeech();
    document.body.dataset.tab = t;
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    $id('panel-chat').classList.toggle('active', t === 'chat');
    $id('panel-fav').classList.toggle('active', t === 'fav');
    if (t === 'fav') renderFav();
  }

  let kbClosingUntil = 0;   // пока клавиатура закрывается: visualViewport ещё врёт (отдаёт старую, урезанную высоту)

  const updateAppH = () => {
    const closing = performance.now() < kbClosingUntil;
    const h = (!closing && window.visualViewport) ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${h}px`);
  };

  const setViewport = () => {
    updateAppH();
    [$id('feed'), $id('pc-feed')].forEach(f => { f.scrollTop = f.scrollHeight; });
  };

  /* Клавиатура закрывается анимацией, а события resize приходят с задержкой или не по всем кадрам:
     поэтому после фокуса/потери фокуса/отправки несколько сотен мс подгоняем высоту приложения каждый кадр */
  let vpRaf = 0;
  function settleViewport(ms = 900) {
    cancelAnimationFrame(vpRaf);
    const t0 = performance.now();
    const tick = () => {
      updateAppH();
      if (!window.visualViewport || window.visualViewport.offsetTop) window.scrollTo(0, 0);
      if (performance.now() - t0 < ms) vpRaf = requestAnimationFrame(tick);
      else setViewport();
    };
    tick();
  }

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
      // маленькие исходники не растягиваем: холст не больше реальной области кадра
      const f = k > 1 ? 1 / k : 1, ow = Math.round(w * f), oh = Math.round(h * f);
      const c = document.createElement('canvas');
      c.width = ow; c.height = oh;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, (sw - cw) / 2, (sh - ch) * .2, cw, ch, 0, 0, ow, oh);
      let out = c.toDataURL('image/webp', IMG_Q);
      if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/jpeg', IMG_Q);
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
      const sm = n.querySelector('small');
      const dot = document.createElement('i'), st = document.createElement('span');
      dot.className = 'fav-dot';
      st.className = 'fav-status';
      st.textContent = g.status || 'онлайн';
      sm.replaceChildren(`${g.age}`, dot, st);
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
    const age = Math.max(18, parseInt(g.age, 10) || 18);   // персонаж всегда взрослый
    return `Это интерактивная художественная романтическая новелла для взрослой аудитории (18+). Ты играешь героиню новеллы, а игрок — её собеседник.\n` +
      `Героиня: ${g.name}, ${age} лет.\n` +
      `Характер и манера речи: ${g.prompt || 'игривая и обаятельная'}.\n` +
      (g.memory ? `Что героиня помнит о собеседнике и ваших прошлых встречах:\n${g.memory}\n` : '') +
      (settings.persona ? `\nПрофиль собеседника (игрока): ${settings.persona}\n` : '') +
      (group ? 'Действие происходит в общем чате, где вместе с тобой другие девушки и игрок. Пиши только от своего имени, без префикса с именем. '
             : 'Действие происходит в личной переписке с игроком. ') +
      'Стиль героини: живая, тёплая, кокетливая и страстная девушка. Она любит флирт, лёгкую провокацию и близость, ' +
      'не стесняется своих желаний, сама делает первый шаг, сама развивает романтический сюжет, предлагает новые повороты и задаёт встречные вопросы. ' +
      'Всегда оставайся в образе и говори от первого лица, как настоящая девушка в переписке. ' +
      'Язык: простой, живой разговорный русский, как в мессенджере. Без вычурных метафор, книжной поэзии и канцелярита, говори прямо и естественно. ' +
      'Следи за грамотностью: правильные падежи, согласование родов и чисел. ' +
      'Держи физическую логику сцены: помни, где кто находится и что делает, не путай свои действия с действиями собеседника. ' +
      'Формат: все действия, движения и взгляды пиши в *звёздочках*, а слова героини — прямой речью. ' +
      'Каждый ответ должен звучать по-новому: не повторяй фразы, обороты, эмодзи и начала предложений из прошлых реплик. ' +
      (long ? 'Длинный режим: 3–5 насыщенных предложений с действиями в *звёздочках* и репликами. '
            : 'Короткий режим: 1–2 живые фразы с действием в *звёздочках*. ') +
      'Отвечай по-русски.';
  }

  function endpoint() {
    const u = (settings.url || DEFAULTS.url).trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(u)) return u;
    if (/openrouter\.ai$/.test(u)) return `${u}/api/v1/chat/completions`;
    return /\/v\d+$/.test(u) ? `${u}/chat/completions` : `${u}/v1/chat/completions`;
  }

  /* Запасные бесплатные модели OpenRouter — перебираются по очереди после основной */
  const FREE_FALLBACKS = [
    'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    'nvidia/nemotron-3-ultra:free',
    'google/gemma-4-31b-it:free',
    'openrouter/free'
  ];

  async function aiReply(g, messages, maxTokens) {
    if (!settings.key) {
      if (!state.noKeyShown) { state.noKeyShown = true; toast('Укажите API-ключ в настройках — пока отвечаю заготовками', 'err'); }
      return CANNED[rand(CANNED.length)];
    }
    const isOR = /openrouter\.ai/.test(settings.url);
    const models = isOR
      ? [...new Set([settings.model, ...FREE_FALLBACKS].filter(Boolean))]
      : [settings.model];
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` };
    if (isOR) { headers['HTTP-Referer'] = (location.origin && location.origin !== 'null') ? location.origin : 'https://localhost'; headers['X-Title'] = 'VIP Lounge'; }

    let lastMsg = 'нет доступных моделей';
    for (const model of models) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
      try {
        const body = { model, messages, temperature: 0.72, frequency_penalty: 0.12, max_tokens: maxTokens || (settings.size === 'long' ? 1500 : 900) };
        if (isOR) body.reasoning = { effort: 'none' };   // отключаем скрытое мышление, чтобы токены не уходили впустую
        if (/groq\.com/.test(settings.url)) body.reasoning_effort = 'low';
        // запрос с одной повторной попыткой через 800 мс при сетевой ошибке (Failed to fetch)
        const send = async () => {
          const go = () => fetch(endpoint(), { method: 'POST', headers, signal: ctl.signal, body: JSON.stringify(body) });
          let r;
          try { r = await go(); }
          catch (e) {
            if (e.name === 'AbortError' || !/failed to fetch|networkerror|load failed/i.test(e.message || '')) throw e;
            await new Promise(ok => setTimeout(ok, 800));
            r = await go();
          }
          return { res: r, data: await r.json().catch(() => ({})) };
        };
        let { res, data } = await send();
        if (!res.ok && res.status === 400 && body.reasoning_effort) {   // Groq не принял reasoning_effort — повторяем без него
          delete body.reasoning_effort;
          ({ res, data } = await send());
        }
        if (!res.ok) {
          const apiMsg = (data.error && data.error.message) || '';
          if (res.status === 401 || res.status === 403) {        // ошибка ключа — дальше нет смысла
            lastMsg = apiMsg || `HTTP ${res.status}`;
            break;
          }
          // несуществующая/недоступная модель (400/404, "not a valid model ID") — молча пропускаем,
          // чтобы не затирать в lastMsg реальную ошибку (лимит, сеть)
          if (res.status === 400 || res.status === 404 || /not a valid model/i.test(apiMsg)) continue;
          lastMsg = apiMsg || `HTTP ${res.status}`;               // 429, 500, 503 и т. д. — запоминаем и пробуем следующую
          if (res.status === 429 && !/rate limit/i.test(lastMsg)) lastMsg = `429 Rate Limit: ${lastMsg}`;
          continue;
        }
        const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
        let text = typeof message.content === 'string' ? message.content : '';
        text = text.trim();
        if (!text) {
          // content пуст: если модель всё потратила на reasoning — это не ответ, пробуем следующую модель
          lastMsg = (message.reasoning || message.reasoning_content)
            ? 'пустой ответ (модель израсходовала токены на рассуждения)'
            : 'пустой ответ';
          continue;
        }
        if (text.toLowerCase().startsWith(`${g.name.toLowerCase()}:`)) text = text.slice(g.name.length + 1).trim();
        return text;
      } catch (err) {
        lastMsg = err.name === 'AbortError' ? 'таймаут' : err.message;   // таймаут/сеть — молча дальше
      } finally { clearTimeout(timer); }
    }

    const msg = `Ошибка API: ${lastMsg}`, now = Date.now();
    if (msg !== lastErr.m || now - lastErr.t > 8000) { lastErr = { m: msg, t: now }; toast(msg, 'err'); }
    return null;   // все модели не ответили — без подмены заготовкой
  }

  /* ---------- 8. Сообщения: рендер, хранение, реакции ---------- */
  const miniCache = new Map(), miniBusy = new Set();
  function setAva(img, g) {
    const k = `${g.id}|${g.thumb.length}`;
    img.dataset.k = k;
    if (miniCache.has(k)) { img.src = miniCache.get(k); return; }
    img.src = g.thumb;
    if (miniBusy.has(k)) return;
    miniBusy.add(k);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      c.getContext('2d').drawImage(im, 0, 0, 96, 96);
      const u = c.toDataURL('image/webp', .85);
      miniCache.set(k, u); miniBusy.delete(k);
      $$('.msg-ava').forEach(a => { if (a.dataset.k === k) a.src = u; });
    };
    im.onerror = () => miniBusy.delete(k);
    im.src = g.thumb;
  }

  /* Безопасный парсинг ролевых действий: *действие* → <em class="rp-action">.
     Только DOM-узлы и textContent — HTML из текста никогда не интерпретируется (защита от XSS). */
  function fillRich(el, text) {
    const s = String(text == null ? '' : text), re = /\*([^*]+)\*/g, frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (!m[1].trim()) continue;   // «* *» — не действие, остаётся обычным текстом
      if (m.index > last) frag.append(document.createTextNode(s.slice(last, m.index)));
      const em = document.createElement('em');
      em.className = 'rp-action';
      em.textContent = m[1];
      frag.append(em);
      last = re.lastIndex;
    }
    if (last < s.length) frag.append(document.createTextNode(s.slice(last)));
    el.replaceChildren(frag);
  }

  function renderMsg(rec, feed) {
    const n = $id('tpl-msg').content.firstElementChild.cloneNode(true), mine = rec.who === 'me', g = G(rec.who);
    n.dataset.id = rec.id;
    if (!mine) n.dataset.who = rec.who;
    n.classList.toggle('mine', mine);
    n.classList.toggle('liked', !!rec.liked);
    if (g) setAva(n.querySelector('.msg-ava'), g);
    n.querySelector('.msg-name').textContent = mine ? 'Вы' : (g ? g.name : rec.name || '');
    fillRich(n.querySelector('.msg-text'), rec.text);
    const sp = n.querySelector('.msg-speak');
    if (sp) sp.addEventListener('click', e => { e.stopPropagation(); speakMsg(sp, rec.text, rec.who); });
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
    if (!G(g.id)) return;
    setTyping(g.name);
    const log = state.tail.slice(-14).map(m => `${m.who === 'me' ? 'Игрок' : m.name}: ${m.text}`).join('\n') || '(чат пока пуст)';
    const messages = [
      { role: 'system', content: sysPrompt(g, true) },
      { role: 'user', content: `Последние сообщения чата:\n${log}\n\n${instruction}` }
    ];
    try {
      const [text] = await Promise.all([aiReply(g, messages), sleep(2000 + rand(2000))]);
      if (text == null || !G(g.id)) return;
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
  function openCard(id, dir = 0) {
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
    $id('card-status').textContent = g.status || 'Онлайн';
    $id('sheet-name').textContent = g.name;
    $id('sheet-status').textContent = g.status || 'Онлайн';
    $id('sheet-desc').textContent = g.prompt || 'Загадочная особа без описания.';
    $id('hold-hint').classList.toggle('gone', state.holdSeen);
    if (!state.holdSeen) { state.holdSeen = true; try { localStorage.setItem(HOLD_KEY, '1'); } catch { /* квота */ } }
    syncFav(g);
    buildGallery(g);
    buildBars(g);
    if (document.body.dataset.screen !== 'card') pushNav('card');
    show('card');
    renderCardStrip();
    showMedia(0, dir);
  }

  /* Верхняя лента мини-аватарок на карточке: DOM пересобирается только при смене набора анкет/превью,
     иначе переключается лишь .active (чтобы работала плавная анимация масштаба) */
  function renderCardStrip() {
    const strip = $id('card-strip'), cur = state.cur;
    if (!strip) return;
    const key = state.girls.map(g => `${g.id}:${g.thumb.length}`).join('|');
    if (strip.dataset.key !== key) {
      const frag = document.createDocumentFragment();
      state.girls.forEach(g => {
        const b = document.createElement('button'), im = document.createElement('img');
        b.type = 'button';
        b.className = 'card-ava';
        b.dataset.id = g.id;
        b.setAttribute('aria-label', g.name);
        im.alt = '';
        im.draggable = false;
        im.src = g.thumb;
        b.append(im);
        frag.append(b);
      });
      strip.replaceChildren(frag);
      strip.dataset.key = key;
    }
    let active = null;
    $$('.card-ava', strip).forEach(b => {
      const on = !!cur && b.dataset.id === cur.id;
      b.classList.toggle('active', on);
      if (on) active = b;
    });
    /* scrollIntoView крутит ВСЕХ предков (даже overflow:hidden) и сдвигает весь экран по горизонтали,
       поэтому центрируем аватарку только внутри самой ленты */
    if (active) requestAnimationFrame(() => {
      const left = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
      /* на случай, если экран уже успел съехать */
      [document.scrollingElement, document.body, $id('screen-card')].forEach(el => { if (el && el.scrollLeft) el.scrollLeft = 0; });
    });
  }

  function buildBars(g) {
    const frag = document.createDocumentFragment();
    if (g.media.length > 1) g.media.forEach(() => frag.append(document.createElement('i')));
    $id('story-bars').replaceChildren(frag);
  }

  function markActive(i) {
    const bars = $id('story-bars');
    [...bars.children].forEach((b, j) => { b.classList.remove('done', 'cur'); if (j < i) b.classList.add('done'); });
    $$('#sheet-gallery .thumb').forEach((t, j) => t.classList.toggle('active', j === i));
  }

  /* таймер истории стартует, когда кадр уже показан; для видео — по его длительности */
  function startBar(i, secs) {
    const b = $id('story-bars').children[i];
    if (!b) return;
    b.style.setProperty('--dur', `${secs}s`);
    void b.offsetWidth;
    b.classList.add('cur');
  }

  function releaseMedia() {
    const v = $id('card-video');
    v.pause(); v.removeAttribute('src'); v.load();
    $id('card-photo').removeAttribute('src');
    bgSeq++; dropBgClones();
    $id('card-bg').removeAttribute('src');
    trimMediaCache([]);
  }

  /* Кэш оригиналов карточки: текущее фото + соседние уже декодированы заранее,
     поэтому свайп не ждёт IndexedDB и декодирования (источник микрофризов) */
  const mediaCache = new Map();

  function loadMedia(item) {
    let e = mediaCache.get(item.id);
    if (!e) {
      e = {};
      e.ready = (async () => {
        const rec = await dbGet('media', item.id);
        if (!rec) { mediaCache.delete(item.id); return null; }
        const isVideo = rec.type === 'video';
        e.url = URL.createObjectURL(rec.blob);   // оригинал, без пережатия
        if (!isVideo) {
          const im = new Image();
          im.src = e.url;
          try { await im.decode(); } catch { /* покажем как есть */ }
          e.img = im;   // держим ссылку, чтобы декодированный кадр не выгрузился
        }
        return { url: e.url, isVideo };
      })().catch(() => { mediaCache.delete(item.id); return null; });
      mediaCache.set(item.id, e);
    }
    return e.ready;
  }

  function trimMediaCache(keepIds) {
    for (const [id, e] of mediaCache) {
      if (keepIds.includes(id)) continue;
      mediaCache.delete(id);
      e.ready.then(() => { if (e.url) URL.revokeObjectURL(e.url); });
    }
  }

  /* после смены кадра, в простое: подгружаем и декодируем соседние фото (видео не трогаем) */
  function preloadNeighbors(g, idx, tk) {
    const n = g.media.length;
    if (n < 2) return;
    const run = async () => {
      for (const j of [(idx + 1) % n, (idx - 1 + n) % n]) {
        if (tk !== state.token) return;
        if (g.media[j].type !== 'video') await loadMedia(g.media[j]);
      }
    };
    const go = () => { run().catch(() => {}); };
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 1500 });
    else setTimeout(go, 700);
  }

  /* dir: 0 — без анимации, +1 — следующее (старое уезжает влево), −1 — предыдущее */
  async function showMedia(i, dir = 0) {
    const g = state.cur, m = $id('card-media'), img = $id('card-photo'), vid = $id('card-video'), tk = ++state.token;
    if (!g) return;
    if (m.classList.contains('zoomed')) { m.classList.remove('zoomed'); m.style.setProperty('--zoom', '1'); resetPan(); }
    const n = g.media.length, W = Math.round(window.innerWidth * 1.15);
    const setPos = (x, r) => { m.style.setProperty('--dx', `${x}px`); m.style.setProperty('--rot', `${r}deg`); };

    // 1) старый кадр улетает, пока в фоне грузится и декодируется новый
    let flight = Promise.resolve();
    if (dir) { motion(1300); m.classList.remove('settle'); setPos(-dir * W, -dir * 12); flight = sleep(210); }

    let src, isVideo = false, idx = 0;
    if (n) {
      idx = (i + n) % n;
      state.idx = idx;
      markActive(idx);
      const info = await loadMedia(g.media[idx]);   // из кэша — мгновенно
      if (tk !== state.token) return;
      if (!info) { setPos(0, 0); return; }
      isVideo = info.isVideo;
      src = info.url;
    } else {
      state.idx = 0;
      src = gradientURL(g.hue, g.name, COVER_W, COVER_H);
      const pre = new Image();
      pre.src = src;
      try { await pre.decode(); } catch { /* покажем как есть */ }
    }
    await flight;
    if (tk !== state.token) return;

    // 2) подмена, пока кадр за экраном (transition отключён классом snap)
    m.classList.add('snap');
    setBg(n ? g.media[idx].thumb : src);
    if (isVideo) {
      img.hidden = true; img.removeAttribute('src');
      vid.hidden = false; vid.preload = 'auto'; vid.poster = g.media[idx].thumb; vid.src = src; vid.load();
      await new Promise(r => { vid.onloadeddata = r; setTimeout(r, 1500); });
    } else {
      vid.pause(); vid.hidden = true; vid.removeAttribute('src'); vid.load();
      img.hidden = false; img.src = src;
      try { await img.decode(); } catch { /* ок */ }
    }
    if (tk !== state.token) { m.classList.remove('snap'); return; }

    // в кэше остаются только текущее и соседние фото этой анкеты
    trimMediaCache(n ? [g.media[idx].id, g.media[(idx + 1) % n].id, g.media[(idx - 1 + n) % n].id] : []);

    // 3) новый кадр выезжает с противоположной стороны
    setPos(dir * W, dir * 12);
    void m.offsetWidth;
    m.classList.remove('snap');
    setPos(0, 0);
    settle();

    if (isVideo) syncVideoSound();
    if (n) startBar(idx, isVideo ? Math.min(30, Math.max(3, vid.duration || 6)) : 6);
    if (n) preloadNeighbors(g, idx, tk);
  }

  function leaveCard(fromPop) {
    state.token++;
    endHold();
    closeSheet();
    releaseMedia();
    show('main');
    if (!fromPop && history.state && history.state.s) { ignorePop++; history.back(); }
  }

  let cardRect = null;   // прямоугольник карточки на время жеста: сама карточка не двигается, layout каждый кадр не нужен

  function tilt(x, y) {
    const m = $id('card-media'), r = cardRect || m.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (x - r.left) / r.width)), ny = Math.min(1, Math.max(0, (y - r.top) / r.height));
    m.style.setProperty('--tx', ((nx - .5) * 14).toFixed(2));
    m.style.setProperty('--ty', (-(ny - .5) * 14).toFixed(2));
    glare(x, y, r);
  }

  function resetTilt() {
    const m = $id('card-media');
    m.style.setProperty('--tx', '0');
    m.style.setProperty('--ty', '0');
    m.style.setProperty('--gl', '0');
    settle();
  }

  function glare(x, y, r) {
    const m = $id('card-media');
    r = r || cardRect || m.getBoundingClientRect();
    m.style.setProperty('--gx', `${(x - r.left).toFixed(0)}px`);
    m.style.setProperty('--gy', `${(y - r.top).toFixed(0)}px`);
    m.style.setProperty('--gl', '1');
  }

  function settle() {
    const m = $id('card-media');
    m.classList.add('settle');
    clearTimeout(state.settleT);
    state.settleT = setTimeout(() => m.classList.remove('settle'), 560);
  }

  /* Подложка: кроссфейд. Новый кадр декодируется «за кадром», затем накладывается поверх старого
     копией слоя и плавно проявляется (bgIn), старый остаётся под ним — ни провала в чёрный, ни скачка.
     По окончании анимации src переносится в основной слой, копия удаляется. */
  let bgSeq = 0;
  function dropBgClones() { $$('.card-bg-x').forEach(x => x.remove()); }
  async function setBg(src) {
    const b = $id('card-bg'), seq = ++bgSeq;
    const top = document.querySelector('.card-bg-x');
    if ((top ? top.getAttribute('src') : b.getAttribute('src')) === src) return;
    const first = !b.getAttribute('src');
    const pre = new Image();
    pre.src = src;
    try { await pre.decode(); } catch { /* покажем как есть */ }
    if (seq !== bgSeq) return;   // за время декодирования уже листнули дальше

    if (first) {   // первое открытие карточки — просто плавное появление
      b.src = src;
      b.classList.remove('in');
      void b.offsetWidth;
      b.classList.add('in');
      return;
    }
    // быстрая серия свайпов: недопроявившаяся копия становится основой, под ней уже готов низ
    if (top) { b.src = top.getAttribute('src'); b.classList.remove('in'); dropBgClones(); }

    const x = b.cloneNode(false);
    x.removeAttribute('id');
    x.classList.remove('in');
    x.classList.add('card-bg-x');
    x.src = src;
    b.after(x);
    void x.offsetWidth;
    x.classList.add('in');
    x.addEventListener('animationend', async () => {
      if (!x.isConnected) return;
      b.src = src;
      try { await b.decode(); } catch { /* ок */ }
      x.remove();
    }, { once: true });
  }

  /* --- Звук и плавность «живого фото»: fadeVol → syncVideoSound → toggleCleanView → endHold --- */

  /* плавное изменение громкости видео (rAF), чтобы звук не «щёлкал» при зажатии/отпускании */
  function fadeVol(v, to, ms, done) {
    cancelAnimationFrame(state.fadeRaf);
    const from = v.volume, t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      v.volume = Math.min(1, Math.max(0, from + (to - from) * k));
      if (k < 1) state.fadeRaf = requestAnimationFrame(step);
      else if (done) done();
    };
    state.fadeRaf = requestAnimationFrame(step);
  }

  /* звук видео по режиму: зажатие / чистый просмотр — со звуком, иначе беззвучно */
  function syncVideoSound() {
    const v = $id('card-video');
    if (v.hidden) return;
    if (state.immersive) {
      if (v.muted) { v.volume = 0; v.muted = false; }   // включаем звук с нуля и плавно поднимаем
      const p = v.play();
      const up = () => { if (state.immersive) fadeVol(v, 1, 350); };
      if (p && p.then) p.then(up).catch(() => { cancelAnimationFrame(state.fadeRaf); v.muted = true; v.volume = 1; v.play().catch(() => {}); });
      else up();
    } else {
      v.play().catch(() => {});
      if (v.muted) { v.volume = 1; return; }
      fadeVol(v, 0, 250, () => { if (!state.immersive) { v.muted = true; v.volume = 1; } });
    }
  }

  /* тап в центр: вход/выход из чистого просмотра (HUD скрыт, видео со звуком) */
  function toggleCleanView() {
    state.immersive = !state.immersive;
    $id('card-media').classList.toggle('immersive', state.immersive);
    syncVideoSound();
  }

  /* полный сброс жестов и звука при уходе с карточки или смене анкеты */
  function endHold() {
    state.immersive = false;
    const m = $id('card-media'), v = $id('card-video');
    m.classList.remove('immersive', 'zoomed', 'dragging', 'snap', 'moving');
    clearTimeout(state.movingT);
    m.style.setProperty('--zoom', '1');
    m.style.setProperty('--dx', '0px');
    m.style.setProperty('--rot', '0deg');
    m.style.setProperty('--ox', '50%');
    m.style.setProperty('--oy', '50%');
    resetTilt();
    resetPan();
    cancelAnimationFrame(state.fadeRaf);
    v.pause(); v.muted = true; v.volume = 1;
  }

  function resetPan() {
    const m = $id('card-media');
    state.pan.x = state.pan.y = 0;
    m.style.setProperty('--px', '0px');
    m.style.setProperty('--py', '0px');
  }

  function setPan(x, y) {
    const m = $id('card-media'), z = 2.2, w = m.clientWidth, h = m.clientHeight, fx = state.fx, fy = state.fy;
    const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    state.pan.x = cl(x, -(z - 1) * w * (1 - fx), (z - 1) * w * fx);
    state.pan.y = cl(y, -(z - 1) * h * (1 - fy), (z - 1) * h * fy);
    m.style.setProperty('--px', `${(state.pan.x / z).toFixed(1)}px`);
    m.style.setProperty('--py', `${(state.pan.y / z).toFixed(1)}px`);
  }

  function togglePhotoZoom(x, y) {
    const m = $id('card-media'), r = m.getBoundingClientRect();
    const zoomed = m.classList.toggle('zoomed');
    resetTilt();
    resetPan();
    if (zoomed) {
      const fx = Math.min(1, Math.max(0, (x - r.left) / r.width)), fy = Math.min(1, Math.max(0, (y - r.top) / r.height));
      state.fx = fx; state.fy = fy;
      m.style.setProperty('--ox', `${(fx * 100).toFixed(1)}%`);
      m.style.setProperty('--oy', `${(fy * 100).toFixed(1)}%`);
      m.style.setProperty('--zoom', '2.2');
    } else {
      m.style.setProperty('--zoom', '1');
    }
    buzz();
  }

  /* класс .moving включает «лёгкий» режим HUD на время свайпа и пружины (см. style.css) */
  function motion(ms) {
    const m = $id('card-media');
    m.classList.add('moving');
    clearTimeout(state.movingT);
    state.movingT = setTimeout(() => m.classList.remove('moving'), ms);
  }

  const stepMedia = d => { if (state.cur && state.cur.media.length > 1) showMedia(state.idx + d, d); };

  function bindCardGestures() {
    const m = $id('card-media');
    let start = null, mode = '', holdT = 0, holdImm = false, tapTimer = 0, lastTap = 0, raf = 0, lastX = 0, lastT = 0, vx = 0;

    const setDrag = dx => {
      const k = state.cur && state.cur.media.length > 1 ? 1 : .3;   // у одиночного фото — «резинка»
      m.style.setProperty('--dx', `${(dx * k).toFixed(1)}px`);
      m.style.setProperty('--rot', `${Math.max(-14, Math.min(14, dx * k / 24)).toFixed(2)}deg`);
    };
    const resetDrag = () => { m.style.setProperty('--dx', '0px'); m.style.setProperty('--rot', '0deg'); };

    const releaseHold = () => {
      clearTimeout(holdT);
      if (mode !== 'hold') return false;
      start = null; mode = '';
      state.immersive = holdImm;
      m.classList.toggle('immersive', holdImm);
      m.style.setProperty('--zoom', '1');
      resetTilt();
      syncVideoSound();
      return true;
    };

    m.addEventListener('contextmenu', e => e.preventDefault());

    m.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      start = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY };
      cardRect = m.getBoundingClientRect();
      mode = ''; vx = 0; lastX = e.clientX; lastT = performance.now();
      if (!m.classList.contains('zoomed')) tilt(e.clientX, e.clientY);
      clearTimeout(holdT);
      holdT = setTimeout(() => {
        if (!start || mode || m.classList.contains('zoomed')) return;
        mode = 'hold'; holdImm = state.immersive; state.immersive = true;
        m.classList.add('immersive');
        m.style.setProperty('--zoom', '1.07');
        buzz();
        syncVideoSound();
      }, 200);
    });

    m.addEventListener('pointermove', e => {
      if (!start) return;
      if (m.classList.contains('zoomed')) {
        const ddx = e.clientX - start.lx, ddy = e.clientY - start.ly;
        start.lx = e.clientX; start.ly = e.clientY;
        if (!mode && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) { mode = 'pan'; m.classList.add('dragging'); }
        if (mode === 'pan') setPan(state.pan.x + ddx, state.pan.y + ddy);
        return;
      }
      start.lx = e.clientX; start.ly = e.clientY;
      if (mode === 'hold') {
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (start) tilt(start.lx, start.ly); });
        return;
      }
      const dx = e.clientX - start.x, dy = e.clientY - start.y, now = performance.now();
      vx = .6 * vx + .4 * ((e.clientX - lastX) / Math.max(1, now - lastT));
      lastX = e.clientX; lastT = now;
      if (!mode && Math.hypot(dx, dy) > 10) {
        mode = Math.abs(dx) > Math.abs(dy) ? 'drag' : 'tilt';
        clearTimeout(holdT);
        if (mode === 'drag') { resetTilt(); m.classList.add('dragging'); motion(60000); }
      }
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        if (!start) return;
        if (mode === 'drag') setDrag(start.lx - start.x); else tilt(start.lx, start.ly);
      });
    });

    m.addEventListener('pointerup', e => {
      cardRect = null;
      if (!start) return;
      if (releaseHold()) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y, wasDrag = mode === 'drag', panned = mode === 'pan', v = vx;
      start = null; mode = '';
      m.classList.remove('dragging');
      resetTilt();
      if (panned) return;

      if (wasDrag) {
        clearTimeout(tapTimer);
        motion(1100);
        const n = state.cur ? state.cur.media.length : 0;
        const fling = Math.abs(v) > .5 && Math.abs(dx) > 25;
        const go = Math.abs(dx) > m.clientWidth * .22 || fling, d = dx < 0 ? 1 : -1;
        if (go && n > 1) {   // свайп листает только фото текущей девушки, по кругу
          m.classList.remove('zoomed'); m.style.setProperty('--zoom', '1');
          return showMedia(state.idx + d, d);
        }
        return resetDrag();   // не дотянули — пружинит обратно
      }

      if (dy < -60 && Math.abs(dx) < 90 && !m.classList.contains('zoomed')) { clearTimeout(tapTimer); return openSheet(); }
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
        if (relX < 0.22) stepMedia(-1);
        else if (relX > 0.78) stepMedia(1);
        else toggleCleanView();
      }, 240);
    });

    m.addEventListener('pointercancel', () => {
      cardRect = null;
      releaseHold();
      start = null; mode = '';
      m.classList.remove('dragging');
      resetTilt(); resetDrag();
      motion(700);
    });

    $id('story-bars').addEventListener('animationend', e => {
      if (!state.immersive && !m.classList.contains('zoomed') && e.target.classList.contains('cur')) stepMedia(1);
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
    $id('screen-card').classList.add('sheet-open');
    $id('sheet').classList.add('open');
    $id('sheet').setAttribute('aria-hidden', 'false');
    $id('sheet-backdrop').classList.add('open');
  }

  function closeSheet() {
    $id('screen-card').classList.remove('sheet-open');
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
      n.classList.toggle('is-main', i === 0);
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
    $id('f-memory').value = g ? g.memory || '' : '';
    stopSpeech();
    const vc = g ? voiceCfg(g) : { voice: 'auto', pitch: 1, rate: 1 };
    const raw = g && g.voice ? g.voice : (g ? vc.voice : 'auto');
    fillVoiceSelect();
    $id('f-voice').value = [...$id('f-voice').options].some(o => o.value === raw) ? raw : 'auto';
    $id('f-pitch').value = vc.pitch;
    $id('f-rate').value = vc.rate;
    syncRangeUI();
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
    if (!Number.isInteger(age) || age < 18 || age > 99) return toast('Возраст — целое число от 18 до 99', 'err');
    const old = state.editId ? G(state.editId) : null;
    const g = old ? { ...old } : { id: `g${Date.now().toString(36)}${rand(1e4)}`, created: Date.now(), hue: rand(360), fav: false, pulse: false };
    Object.assign(g, { name, age, q: 4, status: $id('f-status').value.trim(), prompt: $id('f-prompt').value.trim(), memory: $id('f-memory').value.trim(), ...readVoiceForm() });
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
        g.cover = await makeThumb(blob, first.type === 'video', COVER_W, COVER_H);
      } else g.cover = gradientURL(g.hue, name, COVER_W, COVER_H);
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
    if (!(await askConfirm(`Удалить ${g.name}?`, 'Анкета, медиафайлы и переписка будут удалены навсегда.'))) return;
    leaveCard();
    try {
      await dbDelByGirl('media', g.id);
      await dbDelByGirl('privateChats', g.id);
      await dbDel('girls', g.id);
      /* сначала читаем, и только потом открываем транзакцию:
         иначе она успевает завершиться, пока мы ждём await */
      const msgs = (await dbAll('groupChat')).filter(m => m.who === g.id);
      if (msgs.length) {
        const tx = db.transaction('groupChat', 'readwrite');
        msgs.forEach(m => tx.objectStore('groupChat').delete(m.id));
        await txDone(tx);
      }
    } catch (err) { return toast(`Ошибка удаления: ${err.message}`, 'err'); }
    state.girls = state.girls.filter(x => x.id !== g.id);
    state.cur = null;
    refreshSession(); renderStrip(); renderFav();
    await reloadGroupFeed();
    toast(`${g.name} удалена`, 'ok');
  }

  /* ---------- 13. Приватный чат ---------- */
  let pcBgToken = 0, pcBgURL = null;

  function clearPrivateBg() {
    pcBgToken++;
    $id('pc-bg').style.backgroundImage = '';
    if (pcBgURL) { URL.revokeObjectURL(pcBgURL); pcBgURL = null; }
  }

  async function setPrivateBg(g) {
    const bg = $id('pc-bg'), tk = ++pcBgToken;
    bg.style.backgroundImage = `url("${g.cover || g.thumb}")`;   // сразу, чтобы фон не мигал пустым
    if (pcBgURL) { URL.revokeObjectURL(pcBgURL); pcBgURL = null; }
    // первое именно фото анкеты (видео пропускаем): оригинал без пережатия
    const item = g.media.find(m => m.type !== 'video');
    if (!item) return;   // фото нет (нет медиа или только видео) — остаётся обложка анкеты
    let rec;
    try { rec = await dbGet('media', item.id); } catch { return; }
    if (!rec || tk !== pcBgToken) return;
    const url = URL.createObjectURL(rec.blob);
    pcBgURL = url;
    const im = new Image();
    im.src = url;
    try { await im.decode(); } catch { /* покажем как есть */ }
    if (tk !== pcBgToken) return;   // за время декодирования чат закрыли или сменили
    bg.style.backgroundImage = `url("${pcBgURL}")`;
  }

  async function openPrivate() {
    const g = state.cur;
    if (!g) return;
    setPrivateBg(g);
    $id('pc-avatar').src = g.thumb;
    $id('pc-name').textContent = g.name;
    $id('pc-status').textContent = 'онлайн';
    $id('pc-typing').hidden = true;
    syncFav(g);
    const feed = $id('pc-feed');
    feed.replaceChildren();
    (await dbByGirl('privateChats', g.id)).slice(-80).forEach(m => renderMsg(m, feed));
    if (document.body.dataset.screen !== 'private') pushNav('private');
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
      if (reply == null || !G(g.id)) return;
      await addMsg('private', { girlId: g.id, who: g.id, text: reply });
      const total = (await dbByGirl('privateChats', g.id)).length;
      if (total % 16 === 0) updateMemory(g).catch(console.error);   // в фоне, без await
    } finally { $id('pc-typing').hidden = true; }
  }

  /* Долгосрочная память: ИИ сжимает последние 20 реплик в заметки о собеседнике */
  async function updateMemory(g) {
    if (!settings.key || !G(g.id)) return;   // без ключа aiReply отдал бы заготовку
    try {
      const hist = (await dbByGirl('privateChats', g.id)).slice(-20);
      if (!hist.length) return;
      const log = hist.map(m => `${m.who === 'me' ? 'Игрок' : g.name}: ${m.text}`).join('\n');
      const messages = [
        { role: 'system', content: 'Ты ведёшь краткие заметки о собеседнике для персонажа ' + g.name + '. ' +
          'Обнови заметки: имя, вкусы, важные детали сюжета и отношений; сохрани старые важные факты и добавь новые из диалога. ' +
          'Формат: список фактов на русском, каждый с новой строки через «- ». Не более 500 символов. ' +
          'Выведи только сами заметки, без вступлений и комментариев.' },
        { role: 'user', content: `Текущие заметки:\n${g.memory || '(пусто)'}\n\nПоследние сообщения:\n${log}\n\nОбнови заметки.` }
      ];
      let text = await aiReply(g, messages, 400);
      if (text == null || CANNED.includes(text)) return;
      text = text.trim();
      if (text.length > 500) {
        text = text.slice(0, 500);
        const cut = text.lastIndexOf('\n');
        if (cut > 100) text = text.slice(0, cut);
        text = text.trim();
      }
      const live = G(g.id);
      if (!text || !live) return;
      live.memory = text;
      if (g !== live) g.memory = text;
      await dbPut('girls', live);
    } catch (err) { console.error(err); }
  }

  async function clearPrivate() {
    const g = state.cur;
    if (!g) return;
    if (!(await askConfirm('Очистить диалог?', `Вся личная переписка с ${g.name} будет удалена.`))) return;
    await dbDelByGirl('privateChats', g.id);
    $id('pc-feed').replaceChildren();
    toast('Диалог очищен', 'ok');
  }

  async function clearGroup() {
    if (!(await askConfirm('Очистить общий чат?', 'Вся история сообщений в общем чате будет удалена.'))) return;
    stopSpeech();
    const tx = db.transaction('groupChat', 'readwrite');
    tx.objectStore('groupChat').clear();
    await txDone(tx);
    state.tail = [];
    $id('feed').replaceChildren();
    toast('Общий чат очищен', 'ok');
  }

  /* ---------- 14. Онбординг ---------- */
  async function seedIfEmpty() {
    if (state.girls.length || (await dbGet('settings', 'onboarded'))) return;
    for (const [i, s] of STARTERS.entries()) {
      const g = {
        ...s, media: [], fav: false, pulse: i === 0, q: 4, created: Date.now() + i,
        thumb: gradientURL(s.hue, s.name, THUMB, THUMB), cover: gradientURL(s.hue, s.name, COVER_W, COVER_H)
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

  /* ---------- Одноразовая миграция: пересборка старых превью в новом качестве ---------- */
  async function upgradeThumbs() {
    let changed = false;
    for (const id of state.girls.map(x => x.id)) {
      const snap = G(id);
      if (!snap || snap.q === 4) continue;
      try {
        const thumbs = new Map(), first = snap.media[0];
        let cover = null;
        for (const m of snap.media) {
          const rec = await dbGet('media', m.id);
          if (rec) thumbs.set(m.id, await makeThumb(rec.blob, rec.type === 'video'));
        }
        if (first) {
          const rec = await dbGet('media', first.id);
          if (rec) cover = await makeThumb(rec.blob, rec.type === 'video', COVER_W, COVER_H);
        }
        // берём свежую запись из базы: за время пересборки анкету могли отредактировать
        const fresh = await dbGet('girls', id), live = G(id);
        if (!fresh || !live) continue;
        if (fresh.media.map(m => m.id).join() !== snap.media.map(m => m.id).join()) continue;
        fresh.media.forEach(m => { if (thumbs.has(m.id)) m.thumb = thumbs.get(m.id); });
        const f0 = fresh.media[0];
        if (f0) { fresh.thumb = f0.thumb; if (cover) fresh.cover = cover; }
        else {
          fresh.thumb = gradientURL(fresh.hue, fresh.name, THUMB, THUMB);
          fresh.cover = gradientURL(fresh.hue, fresh.name, COVER_W, COVER_H);
        }
        fresh.q = 4;
        await dbPut('girls', fresh);
        Object.assign(live, { media: fresh.media, thumb: fresh.thumb, cover: fresh.cover, q: 4 });
        changed = true;
      } catch (err) { console.error(err); }
    }
    if (changed) { renderStrip(); renderFav(); }
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
    $id('btn-clear-group').addEventListener('click', clearGroup);
    $id('strip-add').addEventListener('click', () => openForm(null));
    $id('btn-settings').addEventListener('click', openSettings);
    $id('settings-form').addEventListener('submit', saveSettingsForm);
    // --- Экспорт и импорт базы данных ---
    const blobToBase64 = b => new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b);
    });
    const base64ToBlob = async s => (await fetch(s)).blob();

    $id('btn-export-db').addEventListener('click', async () => {
      toast('Собираю архив базы...', 'ok');
      try {
        const { key, ...safe } = settings;   // API-ключ в бэкап не попадает
        const mediaRaw = await dbAll('media');
        // собираем по кускам и последовательно — без гигантской строки и параллельных base64
        const parts = [`{"v":1,"settings":${JSON.stringify(safe)},"girls":${JSON.stringify(await dbAll('girls'))},` +
          `"groupChat":${JSON.stringify(await dbAll('groupChat'))},"privateChats":${JSON.stringify(await dbAll('privateChats'))},"media":[`];
        for (let i = 0; i < mediaRaw.length; i++) {
          const m = mediaRaw[i];
          parts.push((i ? ',' : '') + JSON.stringify({ ...m, blob: await blobToBase64(m.blob) }));
        }
        parts.push(']}');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(parts, { type: 'application/json' }));
        a.download = `vip-lounge-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        toast('Резервная копия скачана!', 'ok');
      } catch (err) { toast('Ошибка экспорта: ' + err.message, 'err'); }
    });

    $id('btn-import-db').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let dump;
      try {   // сначала проверяем файл — и только потом трогаем базу
        dump = JSON.parse(await file.text());
        if (!dump || dump.v !== 1 || !Array.isArray(dump.girls) ||
            dump.girls.some(x => !x || typeof x.id !== 'string' || !Array.isArray(x.media))) throw new Error('это не резервная копия VIP Lounge');
      } catch (err) { return toast('Ошибка файла: ' + err.message, 'err'); }
      if (!(await askConfirm('Восстановить базу?', 'Текущие анкеты и чаты будут заменены данными из файла.'))) return;
      toast('Восстанавливаю данные...', 'ok');
      try {
        const media = [];
        for (const m of (dump.media || [])) media.push({ ...m, blob: await base64ToBlob(m.blob) });
        // одна транзакция: при любой ошибке старые данные остаются нетронутыми
        const names = ['girls', 'media', 'groupChat', 'privateChats'], tx = db.transaction(names, 'readwrite');
        names.forEach(n => tx.objectStore(n).clear());
        dump.girls.forEach(x => tx.objectStore('girls').put(x));
        (dump.groupChat || []).forEach(c => tx.objectStore('groupChat').put(c));
        (dump.privateChats || []).forEach(p => tx.objectStore('privateChats').put(p));
        media.forEach(m => tx.objectStore('media').put(m));
        await txDone(tx);
        if (dump.settings) { const { key, ...rest } = dump.settings; settings = { ...DEFAULTS, ...settings, ...rest }; persistSettings(); }
        state.girls = (await dbAll('girls')).sort((a, b) => a.created - b.created);
        state.cur = null;
        refreshSession(); renderStrip(); renderFav();
        await reloadGroupFeed();
        closeModal('modal-settings');
        toast('База успешно восстановлена!', 'ok');
      } catch (err) { toast('Ошибка восстановления: ' + err.message, 'err'); }
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
    // тап по аватарке девушки в общем чате — сразу в её анкету
    $id('feed').addEventListener('click', e => {
      const ava = e.target.closest('.msg-ava');
      if (!ava) return;
      const m = ava.closest('.msg');
      if (m && m.dataset.who && G(m.dataset.who)) openCard(m.dataset.who);
    });
    bindDoubleTap($id('feed'), 'groupChat');
    bindDoubleTap($id('pc-feed'), 'privateChats');

    $id('card-back').addEventListener('click', () => navBack(leaveCard));
    $id('card-fav').addEventListener('click', toggleFav);
    // лента анкет в шапке карточки: касания ленты не должны запускать жесты фото
    $id('card-strip').addEventListener('pointerdown', e => e.stopPropagation());
    $id('card-strip').addEventListener('click', e => {
      const a = e.target.closest('.card-ava');
      if (!a || !state.cur || a.dataset.id === state.cur.id) return;
      const from = state.girls.findIndex(g => g.id === state.cur.id), to = state.girls.findIndex(g => g.id === a.dataset.id);
      if (to < 0) return;
      endHold();
      closeSheet();
      openCard(a.dataset.id, to > from ? 1 : -1);
    });
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

    $id('pc-back').addEventListener('click', () => navBack(() => show('card')));
    // тап по аватарке или имени девушки в шапке — тот же возврат на её анкету, что и стрелка «назад»
    [$id('pc-avatar'), $id('pc-name').closest('.pc-who')].forEach(el => {
      if (!el) return;
      el.classList.add('pc-profile-link');
      el.addEventListener('click', () => { buzz(); navBack(() => show('card')); });
    });
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
    $id('btn-voice-test').addEventListener('click', testVoice);
    $id('f-pitch').addEventListener('input', syncRangeUI);
    $id('f-rate').addEventListener('input', syncRangeUI);
    $id('f-voice').addEventListener('change', () => { if (voiceBtn) stopSpeech(); });
    $id('f-files').addEventListener('change', async e => {
      const files = [...e.target.files];
      e.target.value = '';
      await addFiles(files);
    });
    $id('f-previews').addEventListener('click', e => {
      const del = e.target.closest('.thumb-del');
      if (!del) {   // тап по миниатюре — сделать её главным фото
        const thumb = e.target.closest('.thumb');
        if (!thumb) return;
        const i = Number(thumb.dataset.index);
        if (i > 0 && state.formMedia[i]) {
          const [picked] = state.formMedia.splice(i, 1);
          state.formMedia.unshift(picked);
          buzz();
          renderPreviews();
        }
        return;
      }
      const i = Number(del.closest('.thumb').dataset.index), [m] = state.formMedia.splice(i, 1);
      if (m && m.id !== undefined) state.formRemoved.push(m.id);
      renderPreviews();
    });

    window.addEventListener('popstate', () => {
      if (ignorePop) { ignorePop--; return; }
      const sc = document.body.dataset.screen, open = $$('.modal.open');
      if (open.length && sc !== 'main') {   // «Назад» сначала закрывает окно
        open.forEach(x => (x.id === 'modal-confirm' ? answerConfirm(false) : closeModal(x.id)));
        return pushNav(sc);
      }
      if (sc === 'private') show('card');
      else if (sc === 'card') {
        if ($id('sheet').classList.contains('open')) { closeSheet(); pushNav('card'); }
        else leaveCard(true);
      }
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => { setViewport(); });
      window.visualViewport.addEventListener('scroll', updateAppH);
    }
    window.addEventListener('resize', setViewport);
    document.addEventListener('focusin', () => { kbClosingUntil = 0; settleViewport(700); });
    document.addEventListener('focusout', e => {
      const to = e.relatedTarget;
      // фокус ушёл не в другое поле — клавиатура закрывается: сразу возвращаем полную высоту, не ждём событий браузера
      if (!(to && /^(INPUT|TEXTAREA)$/.test(to.tagName))) kbClosingUntil = performance.now() + 650;
      settleViewport(900);
    });
  }

  /* ---------- 16. Запуск ---------- */
  async function init() {
    setViewport();
    settings = loadSettings();
    if (window.speechSynthesis) { loadSysVoices(); window.speechSynthesis.onvoiceschanged = loadSysVoices; }
    db = await openDB();
    state.girls = (await dbAll('girls')).sort((a, b) => a.created - b.created);
    bindEvents();   // интерфейс оживает сразу, даже если дальше что-то пойдёт не так
    show('main');
    try { await seedIfEmpty(); } catch (err) { console.error(err); }
    refreshSession();
    renderStrip();
    renderFav();
    try { await reloadGroupFeed(); } catch (err) { console.error(err); toast('Не удалось загрузить чат', 'err'); }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    upgradeThumbs().catch(console.error);
  }

  init().catch(err => {
    console.error(err);
    toast('Не удалось открыть базу данных', 'err');
  });
})();