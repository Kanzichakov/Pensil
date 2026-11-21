// VIP Lounge TTS Worker v8
// GET/POST, CORS, ?debug, очистка текста, голоса Светлана/Дарья/Елена,
// двухуровневый кэш (in-memory LRU isolate + caches.default), быстрый перебор Edge-TTS прокси
// (встроенные + EXTRA_PROXIES из настроек Cloudflare), откат на Google TTS с разбивкой текста и чисткой ID3.
//
// Необязательные переменные окружения (Cloudflare Dashboard → Workers → Settings → Variables):
//   ALLOWED_ORIGIN           — список разрешённых Origin через запятую (строгий режим CORS)
//   ALLOWED_REFERER          — хосты через запятую для мягкой проверки Origin/Referer (когда ALLOWED_ORIGIN не задан);
//                              запросы совсем без этих заголовков пропускаются
//   API_TOKEN                — если задан, запросы без верного токена получают 401
//   EXTRA_PROXIES            — дополнительные Edge-TTS прокси (URL через запятую), пробуются первыми
//   DISABLE_BUILTIN_PROXIES  — "1": не использовать встроенный список (только EXTRA_PROXIES)
//   MEM_CACHE_SIZE           — размер in-memory кэша в фразах (по умолчанию 80)

const CACHE_TTL = 86400;        // кэш Edge-озвучки: 24 часа
const FALLBACK_TTL = 3600;      // кэш Google-озвучки: 1 час (чтобы Edge мог вернуться)
const PROXY_TIMEOUT = 4500;     // таймаут одного прокси, мс
const PROXY_STAGGER = 800;      // через сколько запускать следующий прокси, если предыдущий ещё думает
const RACE_DEADLINE = 6500;     // общий предел ожидания Edge-TTS до отката на Google
const GOOGLE_CHUNK = 180;       // лимит символов Google TTS
const GOOGLE_TIMEOUT = 6000;
const MAX_TEXT = 1000;
const MAX_PROXIES = 12;         // потолок списка прокси (встроенные + EXTRA_PROXIES)

const MEM_MAX_ENTRIES = 80;                 // in-memory LRU: максимум фраз
const MEM_MAX_BYTES = 24 * 1024 * 1024;     // и максимум байт (isolate живёт в ~128 МБ)

let lastGoodProxy = null;       // запоминаем последний рабочий прокси в рамках isolate

const memCache = new Map();     // ключ -> { buf, source, exp, size }; порядок вставки = порядок давности использования
let memBytes = 0;
const inflight = new Map();     // ключ -> Promise: одинаковые одновременные запросы делят один синтез

const CORS_STATIC = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Token",
  "Access-Control-Expose-Headers": "X-Cache, X-TTS-Source",
};

// ---------- Доступ и CORS ----------

// ALLOWED_ORIGIN задан — строгая проверка Origin.
// Не задан — «мягкий» режим: запросы без Origin и Referer пропускаются (GET, PWA standalone, строгая приватность);
// если заголовки есть — Origin и Referer не должны противоречить друг другу, а при заданном ALLOWED_REFERER
// хост должен входить в список. Это не защита от целенаправленной подделки заголовков, а барьер от чужих сайтов
// и случайного использования. Для усиления есть API_TOKEN.
function corsFor(req, env) {
  const list = String((env && env.ALLOWED_ORIGIN) || "").split(",").map((x) => x.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";

  if (list.length) {
    if (origin && !list.includes(origin)) return null;
    return { ...CORS_STATIC, "Access-Control-Allow-Origin": origin || list[0], Vary: "Origin" };
  }
  if (!softRefererOk(req, env, origin)) return null;
  return { ...CORS_STATIC, "Access-Control-Allow-Origin": "*" };
}

function hostOf(value) {
  try { return new URL(value).host.toLowerCase(); } catch (_) { return ""; }
}

function softRefererOk(req, env, origin) {
  const referer = req.headers.get("Referer") || "";
  const oHost = hostOf(origin);
  const rHost = hostOf(referer);

  // Ни Origin, ни Referer: так бывает у GET-запросов, у PWA в режиме standalone и при строгой приватности — не блокируем
  if (!oHost && !rHost) return true;
  // Оба заголовка есть, но хосты разные — подозрительно
  if (oHost && rHost && oHost !== rHost) return false;

  const allow = String((env && env.ALLOWED_REFERER) || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  if (!allow.length) return true;
  // Хост сверяем только когда хотя бы один из заголовков присутствует
  return allow.includes(oHost || rHost);
}

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Необязательный токен: заголовок X-Api-Token, либо Authorization: Bearer <токен>, либо ?token=
function tokenOk(req, url, env) {
  const need = String((env && env.API_TOKEN) || "").trim();
  if (!need) return true;
  const auth = req.headers.get("Authorization") || "";
  const got = req.headers.get("X-Api-Token") || (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : "") || url.searchParams.get("token") || "";
  return safeEqual(got.trim(), need);
}

// ---------- In-memory LRU (на уровне isolate) ----------

function memLimit(env) {
  const n = parseInt((env && env.MEM_CACHE_SIZE) || "", 10);
  return Number.isFinite(n) ? Math.min(500, Math.max(10, n)) : MEM_MAX_ENTRIES;
}

function memDrop(key, entry) {
  if (memCache.delete(key)) memBytes -= entry.size;
}

function memGet(key) {
  const e = memCache.get(key);
  if (!e) return null;
  if (e.exp <= Date.now()) {
    memDrop(key, e);
    return null;
  }
  memCache.delete(key);   // «освежаем» запись: переносим в конец очереди
  memCache.set(key, e);
  return e;
}

function memSet(key, buf, source, ttl, env) {
  const size = buf.byteLength;
  if (size > MEM_MAX_BYTES / 4) return;   // слишком крупная запись не вытесняет весь кэш
  const old = memCache.get(key);
  if (old) memDrop(key, old);
  memCache.set(key, { buf, source, exp: Date.now() + ttl * 1000, size });
  memBytes += size;
  const max = memLimit(env);
  while (memCache.size > max || memBytes > MEM_MAX_BYTES) {
    const oldest = memCache.keys().next().value;   // самая давняя запись
    if (oldest === undefined) break;
    memDrop(oldest, memCache.get(oldest));
  }
}

// ---------- Обработчик ----------

export default {
  async fetch(req, env, ctx) {
    const CORS = corsFor(req, env);
    if (!CORS) return new Response("Forbidden", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      const url = new URL(req.url);
      if (!tokenOk(req, url, env)) return new Response("Unauthorized", { status: 401, headers: CORS });

      if (url.searchParams.has("debug")) {
        return new Response(await runDebug(env), {
          headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      let text = "";
      let voice = "ru-RU-SvetlanaNeural";
      if (req.method === "GET") {
        text = url.searchParams.get("text") || url.searchParams.get("input") || "";
        voice = url.searchParams.get("voice") || voice;
      } else if (req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        text = b.input || b.text || "";
        voice = b.voice || voice;
      }

      text = cleanText(text);
      if (!text) return new Response("Empty text", { status: 400, headers: CORS });

      const edgeVoice = pickVoice(voice);
      const key = await sha256(edgeVoice + "|" + text);

      // --- Кэш 1: память isolate (работает и на *.workers.dev) ---
      const mem = memGet(key);
      if (mem) return audioResponse(mem.buf, mem.source, "HIT-MEM", CORS);

      // --- Кэш 2: Cloudflare Cache API (на *.workers.dev не работает — тогда это просто пропуск) ---
      const cache = typeof caches !== "undefined" ? caches.default : null;
      const cacheKey = new Request("https://tts-cache.local/" + key);
      const hit = cache ? await cache.match(cacheKey).catch(() => null) : null;
      if (hit) {
        const buf = await hit.arrayBuffer();
        const source = hit.headers.get("X-TTS-Source") || "edge";
        memSet(key, buf, source, source === "google" ? FALLBACK_TTL : CACHE_TTL, env);
        return audioResponse(buf, source, "HIT", CORS);
      }

      // --- Синтез (одинаковые параллельные запросы делят одну задачу) ---
      let job = inflight.get(key);
      if (!job) {
        job = synthesize(text, edgeVoice, env)
          .then((r) => {
            memSet(key, r.buf, r.source, r.ttl, env);
            if (cache) {
              const putPromise = cache.put(cacheKey, new Response(r.buf, { headers: audioHeaders(r.source) })).catch(() => {});
              if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(putPromise);
            }
            return r;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, job);
      }
      const r = await job;
      return audioResponse(r.buf, r.source, "MISS", CORS);
    } catch (e) {
      return new Response(String((e && e.message) || e), { status: 500, headers: CORS });
    }
  },
};

async function synthesize(text, edgeVoice, env) {
  try {
    const buf = await raceProxies(text, edgeVoice, env);
    return { buf, source: "edge", ttl: CACHE_TTL };
  } catch (_) {
    const buf = await fetchGoogle(text);
    return { buf, source: "google", ttl: FALLBACK_TTL };
  }
}

function audioHeaders(source) {
  const ttl = source === "google" ? FALLBACK_TTL : CACHE_TTL;
  return {
    "Content-Type": "audio/mpeg",
    "Cache-Control": `public, max-age=${ttl}`,
    "X-TTS-Source": source,
  };
}

function audioResponse(buf, source, cacheState, CORS) {
  const h = new Headers(audioHeaders(source));
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  h.set("X-Cache", cacheState);
  return new Response(buf, { status: 200, headers: h });
}

function cleanText(input) {
  return String(input)
    .replace(/\*[^*]*\*/g, " ")
    .replace(/[*_~`#>]+/g, " ")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

function pickVoice(voice) {
  const v = String(voice).toLowerCase();
  if (v.includes("dariya") || v.includes("baya")) return "ru-RU-DariyaNeural";
  if (v.includes("elena") || v.includes("xenia")) return "ru-RU-ElenaNeural";
  return "ru-RU-SvetlanaNeural";
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- Edge-TTS прокси ----------

// EXTRA_PROXIES: URL через запятую/пробел/перевод строки. Принимаются только https.
// Допустимы форматы: https://host, https://host/v1, https://host/v1/audio/speech — путь достраивается сам.
function parseExtraProxies(raw) {
  const out = [];
  for (const item of String(raw || "").split(/[\s,;]+/)) {
    if (!item) continue;
    try {
      const u = new URL(item);
      if (u.protocol !== "https:") continue;
      let path = u.pathname.replace(/\/+$/, "");
      if (/\/audio\/speech$/.test(path)) {
        // уже полный путь
      } else if (/\/v1$/.test(path)) {
        path += "/audio/speech";
      } else {
        path += "/v1/audio/speech";
      }
      out.push(u.origin + path);
    } catch (_) {}
  }
  return out;
}

function getProxies(env) {
  const hf = ["hf", "space"].join(".");
  const builtin = [
    "https://" + ["edgetts", "vercel", "app"].join(".") + "/v1/audio/speech",
    "https://" + ["edge-tts", "vercel", "app"].join(".") + "/v1/audio/speech",
    "https://" + ["tts", "travisvn", "com"].join(".") + "/v1/audio/speech",
    "https://" + ["openai-edge-tts", "vercel", "app"].join(".") + "/v1/audio/speech",
    "https://" + ["innoai-edge-tts"].join("-") + "." + hf + "/v1/audio/speech",
    "https://" + ["k2-fsa-text-to-speech"].join("-") + "." + hf + "/v1/audio/speech",
  ];
  const extra = parseExtraProxies(env && env.EXTRA_PROXIES);
  const onlyExtra = extra.length && /^(1|true|yes|on)$/i.test(String((env && env.DISABLE_BUILTIN_PROXIES) || "").trim());
  // свои зеркала идут первыми: их добавляют, когда встроенные «протухли»
  return [...new Set(onlyExtra ? extra : [...extra, ...builtin])].slice(0, MAX_PROXIES);
}

// Ступенчатая гонка: стартуем первый прокси, следующий — через PROXY_STAGGER мс
// или сразу при сбое предыдущего. Побеждает первый успешный ответ, остальные отменяются.
function raceProxies(text, voice, env) {
  return new Promise((resolve, reject) => {
    const list = getProxies(env);
    if (lastGoodProxy) {
      const i = list.indexOf(lastGoodProxy);
      if (i > 0) {
        list.splice(i, 1);
        list.unshift(lastGoodProxy);
      }
    }

    const ctls = [];
    let next = 0;
    let failed = 0;
    let done = false;
    let lastErr;
    let ticker;
    let deadline;

    const cleanup = () => {
      done = true;
      clearInterval(ticker);
      clearTimeout(deadline);
      for (const c of ctls) {
        try { c.abort(); } catch (_) {}
      }
    };

    const launch = () => {
      if (done || next >= list.length) return;
      const u = list[next++];
      const ctl = new AbortController();
      ctls.push(ctl);
      callOpenAITTS(u, text, voice, ctl)
        .then((buf) => {
          if (done) return;
          lastGoodProxy = u;
          cleanup();
          resolve(buf);
        })
        .catch((e) => {
          if (done) return;
          lastErr = e;
          failed++;
          if (failed >= list.length) {
            cleanup();
            reject(lastErr);
          } else {
            launch();
          }
        });
    };

    deadline = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(lastErr || new Error("Edge-TTS deadline"));
    }, RACE_DEADLINE);

    if (!list.length) {
      cleanup();
      reject(new Error("No proxies"));
      return;
    }
    launch();
    ticker = setInterval(launch, PROXY_STAGGER);
  });
}

async function callOpenAITTS(endpoint, text, voice, ctl) {
  ctl = ctl || new AbortController();
  const t = setTimeout(() => ctl.abort(), PROXY_TIMEOUT);
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-edge-tts",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice,
        response_format: "mp3",
      }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    if (ct && !/audio|octet|mpeg/i.test(ct)) throw new Error(`bad ct: ${ct}`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 800) throw new Error("too small");
    return buf;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Google TTS (откат) ----------

function splitForGoogle(text, max = GOOGLE_CHUNK) {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const chunks = [];
  let cur = "";

  const push = (piece) => {
    piece = piece.trim();
    if (!piece) return;
    const joined = cur ? cur + " " + piece : piece;
    if (joined.length <= max) {
      cur = joined;
    } else {
      if (cur) chunks.push(cur);
      cur = piece;
    }
  };

  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (t.length <= max) {
      push(t);
      continue;
    }
    // Длинное предложение: сначала по запятым/точкам с запятой, затем по пробелам
    const parts = t.split(/(?<=[,;:—-])\s+/);
    for (const part of parts) {
      if (part.length <= max) {
        push(part);
        continue;
      }
      for (const w of part.split(" ")) {
        if (w.length > max) {
          for (let i = 0; i < w.length; i += max) push(w.slice(i, i + max));
        } else {
          push(w);
        }
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function fetchGoogleChunk(chunk, idx, total) {
  const h = ["translate", "google", "com"].join(".");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), GOOGLE_TIMEOUT);
  try {
    const r = await fetch(
      `https://${h}/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=ru&client=tw-ob&total=${total}&idx=${idx}&textlen=${chunk.length}`,
      {
        headers: { "User-Agent": "Mozilla/5.0", Referer: `https://${h}/` },
        signal: ctl.signal,
      }
    );
    if (!r.ok) throw new Error(`Google ${r.status}`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 100) throw new Error("Google: too small");
    return buf;
  } finally {
    clearTimeout(t);
  }
}

// Убирает с MP3-чанка всё, что не является потоком кадров: ID3v2 в начале (в т.ч. несколько подряд, с footer),
// ID3v1 (128 байт «TAG») и APEv2 в конце. Затем, если поток не начинается с синхрослова кадра (0xFF 0xEx),
// ищет его в первых 4 КБ. Возвращает view без копирования.
function stripMp3Tags(input) {
  const u8 = new Uint8Array(input);
  let start = 0;
  let end = u8.length;

  // ID3v2: "ID3", версия, флаги, размер в syncsafe (4 × 7 бит); бит 0x10 флагов — наличие footer (+10 байт)
  while (
    end - start >= 10 &&
    u8[start] === 0x49 && u8[start + 1] === 0x44 && u8[start + 2] === 0x33 &&
    u8[start + 3] < 0xff && u8[start + 4] < 0xff &&
    ((u8[start + 6] | u8[start + 7] | u8[start + 8] | u8[start + 9]) & 0x80) === 0
  ) {
    const size = (u8[start + 6] << 21) | (u8[start + 7] << 14) | (u8[start + 8] << 7) | u8[start + 9];
    start += 10 + size + ((u8[start + 5] & 0x10) ? 10 : 0);
  }
  if (start > end) start = end;

  // ID3v1: последние 128 байт, начинаются с "TAG"
  if (end - start >= 128 && u8[end - 128] === 0x54 && u8[end - 127] === 0x41 && u8[end - 126] === 0x47) end -= 128;

  // APEv2 footer: "APETAGEX", размер (без header) в LE по смещению 12, флаги по смещению 20 (бит 31 — есть header)
  if (end - start >= 32) {
    const sig = String.fromCharCode(...u8.subarray(end - 32, end - 24));
    if (sig === "APETAGEX") {
      const dv = new DataView(u8.buffer, u8.byteOffset + end - 32, 32);
      const total = dv.getUint32(12, true) + ((dv.getUint32(20, true) & 0x80000000) ? 32 : 0);
      if (total >= 32 && total <= end - start) end -= total;
    }
  }

  // Ресинхронизация по первому кадру
  if (!(u8[start] === 0xff && (u8[start + 1] & 0xe0) === 0xe0)) {
    const lim = Math.min(end - 1, start + 4096);
    for (let i = start; i < lim; i++) {
      if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
        start = i;
        break;
      }
    }
  }
  return u8.subarray(start, Math.max(start, end));
}

async function fetchGoogle(text) {
  const chunks = splitForGoogle(text);
  if (!chunks.length) throw new Error("Nothing to synthesize");
  const raw = await Promise.all(chunks.map((c, i) => fetchGoogleChunk(c, i, chunks.length)));
  const parts = raw.map(stripMp3Tags).filter((p) => p.byteLength > 0);
  if (!parts.length) throw new Error("Google: no audio frames");

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out.buffer;
}

// ---------- Отладка ----------

async function runDebug(env) {
  const list = getProxies(env);
  const extraCount = parseExtraProxies(env && env.EXTRA_PROXIES).length;
  const out = [
    "[v8] Проверка Edge-TTS прокси (параллельно, таймаут " + PROXY_TIMEOUT + " мс), всего " + list.length + ", из EXTRA_PROXIES: " + extraCount + ":",
  ];
  const results = await Promise.all(
    list.map(async (u) => {
      const started = Date.now();
      try {
        const buf = await callOpenAITTS(u, "Привет, проверка живого женского голоса", "ru-RU-DariyaNeural");
        return `УСПЕХ: ${u} -> MP3 ${buf.byteLength} байт, ${Date.now() - started} мс`;
      } catch (e) {
        return `Сбой ${u}: ${(e && e.message) || e} (${Date.now() - started} мс)`;
      }
    })
  );
  out.push(...results);

  const started = Date.now();
  try {
    const buf = await fetchGoogle("Проверка запасного голоса.");
    out.push(`Google TTS: OK, MP3 ${buf.byteLength} байт, ${Date.now() - started} мс`);
  } catch (e) {
    out.push(`Google TTS: сбой ${(e && e.message) || e}`);
  }
  out.push(`In-memory кэш: ${memCache.size}/${memLimit(env)} фраз, ${(memBytes / 1048576).toFixed(2)} МБ (живёт, пока жив isolate).`);
  out.push("Кэш Cloudflare (caches.default) работает только на своём домене, не на *.workers.dev.");
  out.push("Защита: ALLOWED_ORIGIN " + (env && env.ALLOWED_ORIGIN ? "задан" : "не задан") + ", API_TOKEN " + (env && env.API_TOKEN ? "задан" : "не задан") + ".");
  return out.join("\n");
}
