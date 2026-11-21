// VIP Lounge TTS Worker v7
// GET/POST, CORS, ?debug, очистка текста, голоса Светлана/Дарья/Елена,
// кэш Cloudflare (24 ч), быстрый перебор Edge-TTS прокси, откат на Google TTS с разбивкой текста.

const CACHE_TTL = 86400;        // кэш Edge-озвучки: 24 часа
const FALLBACK_TTL = 3600;      // кэш Google-озвучки: 1 час (чтобы Edge мог вернуться)
const PROXY_TIMEOUT = 4500;     // таймаут одного прокси, мс
const PROXY_STAGGER = 800;      // через сколько запускать следующий прокси, если предыдущий ещё думает
const RACE_DEADLINE = 6500;     // общий предел ожидания Edge-TTS до отката на Google
const GOOGLE_CHUNK = 180;       // лимит символов Google TTS
const GOOGLE_TIMEOUT = 6000;
const MAX_TEXT = 1000;

let lastGoodProxy = null;       // запоминаем последний рабочий прокси в рамках isolate

const CORS_STATIC = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-Cache, X-TTS-Source",
};

// Необязательно: переменная ALLOWED_ORIGIN (через запятую) в настройках воркера ограничивает, кто может им пользоваться.
// Не задана — работает как раньше (любой источник).
function corsFor(req, env) {
  const list = String((env && env.ALLOWED_ORIGIN) || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!list.length) return { ...CORS_STATIC, "Access-Control-Allow-Origin": "*" };
  const origin = req.headers.get("Origin") || "";
  if (origin && !list.includes(origin)) return null;
  return { ...CORS_STATIC, "Access-Control-Allow-Origin": origin || list[0], Vary: "Origin" };
}

export default {
  async fetch(req, env, ctx) {
    const CORS = corsFor(req, env);
    if (!CORS) return new Response("Forbidden", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      const url = new URL(req.url);
      if (url.searchParams.has("debug")) {
        return new Response(await runDebug(), {
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

      // --- Кэш ---
      const cache = caches.default;
      const cacheKey = new Request("https://tts-cache.local/" + (await sha256(edgeVoice + "|" + text)));
      const hit = await cache.match(cacheKey).catch(() => null);
      if (hit) return finalize(hit, "HIT", hit.headers.get("X-TTS-Source") || "edge", CORS);

      // --- Синтез ---
      let buf;
      let source = "edge";
      let ttl = CACHE_TTL;
      try {
        buf = await raceProxies(text, edgeVoice);
      } catch (_) {
        buf = await fetchGoogle(text);
        source = "google";
        ttl = FALLBACK_TTL;
      }

      const res = new Response(buf, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": `public, max-age=${ttl}`,
          "X-TTS-Source": source,
        },
      });
      const putPromise = cache.put(cacheKey, res.clone()).catch(() => {});
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(putPromise);
      return finalize(res, "MISS", source, CORS);
    } catch (e) {
      return new Response(String((e && e.message) || e), { status: 500, headers: CORS });
    }
  },
};

function finalize(res, cacheState, source, CORS) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  h.set("Content-Type", "audio/mpeg");
  h.set("X-Cache", cacheState);
  h.set("X-TTS-Source", source);
  return new Response(res.body, { status: 200, headers: h });
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

function getProxies() {
  const hf = ["hf", "space"].join(".");
  return [
    "https://" + ["edgetts", "vercel", "app"].join(".") + "/v1/audio/speech",
    "https://" + ["edge-tts", "vercel", "app"].join(".") + "/v1/audio/speech",
    "https://" + ["tts", "travisvn", "com"].join(".") + "/v1/audio/speech",
    "https://" + ["openai-edge-tts", "vercel", "app"].join(".") + "/v1/audio/speech",
    "https://" + ["innoai-edge-tts"].join("-") + "." + hf + "/v1/audio/speech",
    "https://" + ["k2-fsa-text-to-speech"].join("-") + "." + hf + "/v1/audio/speech",
  ];
}

// Ступенчатая гонка: стартуем первый прокси, следующий — через PROXY_STAGGER мс
// или сразу при сбое предыдущего. Побеждает первый успешный ответ, остальные отменяются.
function raceProxies(text, voice) {
  return new Promise((resolve, reject) => {
    const list = getProxies();
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

async function fetchGoogle(text) {
  const chunks = splitForGoogle(text);
  if (!chunks.length) throw new Error("Nothing to synthesize");
  const parts = await Promise.all(chunks.map((c, i) => fetchGoogleChunk(c, i, chunks.length)));
  if (parts.length === 1) return parts[0];

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), offset);
    offset += p.byteLength;
  }
  return out.buffer;
}

// ---------- Отладка ----------

async function runDebug() {
  const list = getProxies();
  const out = ["[v7] Проверка публичных Edge-TTS прокси (параллельно, таймаут " + PROXY_TIMEOUT + " мс):"];
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
  out.push("Кэш Cloudflare (caches.default) работает только на своём домене, не на *.workers.dev.");
  return out.join("\n");
}
