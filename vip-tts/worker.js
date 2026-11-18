export default {
  async fetch(req) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(req.url);
      if (url.searchParams.has("debug")) {
        return new Response(await runDebug(), {
          headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      let text = "", voice = "ru-RU-SvetlanaNeural";
      if (req.method === "GET") {
        text = url.searchParams.get("text") || url.searchParams.get("input") || "";
        voice = url.searchParams.get("voice") || voice;
      } else if (req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        text = b.input || b.text || "";
        voice = b.voice || voice;
      }

      text = String(text)
        .replace(/\*[^*]*\*/g, " ")
        .replace(/[*_~`#>]+/g, " ")
        .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f]/gu, " ")
        .replace(/\s+/g, " ").trim().slice(0, 1000);
      if (!text) return new Response("Empty text", { status: 400, headers: cors });

      const v = String(voice).toLowerCase();
      let edgeVoice = "ru-RU-SvetlanaNeural";
      if (v.includes("dariya") || v.includes("baya")) edgeVoice = "ru-RU-DariyaNeural";
      else if (v.includes("elena") || v.includes("xenia")) edgeVoice = "ru-RU-ElenaNeural";

      const buf = await synthAnyProxy(text, edgeVoice).catch(() => fetchGoogle(text));
      return new Response(buf, {
        headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      });
    } catch (e) {
      return new Response(String(e.message || e), { status: 500, headers: cors });
    }
  },
};

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

async function runDebug() {
  const list = getProxies();
  const out = ["[v6] Проверка публичных Edge-TTS прокси:"];
  for (const u of list) {
    try {
      const buf = await callOpenAITTS(u, "Привет, проверка живого женского голоса", "ru-RU-DariyaNeural");
      out.push(`УСПЕХ: ${u} -> MP3 ${buf.byteLength} байт`);
      return out.join("\n");
    } catch (e) {
      out.push(`Сбой ${u}: ${e.message || e}`);
    }
  }
  return out.join("\n");
}

async function synthAnyProxy(text, voice) {
  let err;
  for (const u of getProxies()) {
    try {
      return await callOpenAITTS(u, text, voice);
    } catch (e) {
      err = e;
    }
  }
  throw err || new Error("All proxies failed");
}

async function callOpenAITTS(endpoint, text, voice) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 7500);
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

async function fetchGoogle(text) {
  const h = ["translate", "google", "com"].join(".");
  const r = await fetch(`https://${h}/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 180))}&tl=ru&client=tw-ob`, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: `https://${h}/` },
  });
  if (!r.ok) throw new Error(`Google ${r.status}`);
  return await r.arrayBuffer();
}
