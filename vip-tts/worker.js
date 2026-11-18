export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Expose-Headers": "X-TTS-Engine, X-TTS-Error",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      let text = "";
      let voice = "svetlana";

      const url = new URL(request.url);
      if (request.method === "GET") {
        text = url.searchParams.get("text") || url.searchParams.get("input") || "";
        voice = url.searchParams.get("voice") || "svetlana";
      } else if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        text = body.input || body.text || "";
        voice = body.voice || "svetlana";
      }

      text = String(text)
        .replace(/\*[^*]*\*/g, " ")
        .replace(/[*_~`#>]+/g, " ")
        .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 700);

      if (!text) {
        return new Response("Empty text", { status: 400, headers: corsHeaders });
      }

      const vLow = String(voice).toLowerCase();
      let speaker = "kseniya";
      if (vLow.includes("dariya") || vLow.includes("baya")) speaker = "baya";
      else if (vLow.includes("elena") || vLow.includes("xenia")) speaker = "xenia";

      let audio;
      let engine = "silero";
      let sileroErr = "";

      try {
        audio = await fetchSileroCascade(text, speaker);
      } catch (e) {
        engine = "google-fallback";
        sileroErr = String(e && e.message ? e.message : e).slice(0, 140);
        audio = await fetchGoogleFallback(text);
      }

      return new Response(audio.buffer, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": audio.type,
          "Cache-Control": "no-store",
          "X-TTS-Engine": engine,
          ...(sileroErr ? { "X-TTS-Error": sileroErr } : {}),
        },
      });
    } catch (err) {
      return new Response(String(err.message || err), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};

function getSileroSpaces() {
  const dom = ["hf", "space"].join(".");
  return [
    "https://" + ["neurosenko", "tts", "silero"].join("-") + "." + dom,
    "https://" + ["farhananis005", "silero", "tts"].join("-") + "." + dom,
  ];
}

async function fetchSileroCascade(text, speaker) {
  let lastErr;
  for (const space of getSileroSpaces()) {
    try {
      return await callGradioSpace(space, text, speaker);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All Silero spaces failed");
}

async function callGradioSpace(space, text, speaker) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 14000);
  const prefixes = ["/gradio_api/call", "/call"];

  try {
    let eventId = "";
    let usedPrefix = "";

    for (const prefix of prefixes) {
      const startRes = await fetch(space + prefix + "/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [text, speaker, 48000] }),
        signal: ctl.signal,
      });
      if (startRes.ok) {
        const json = await startRes.json().catch(() => ({}));
        if (json && json.event_id) {
          eventId = json.event_id;
          usedPrefix = prefix;
          break;
        }
      }
    }

    if (!eventId) throw new Error("No event_id on " + space);

    const streamRes = await fetch(space + usedPrefix + "/predict/" + eventId, {
      signal: ctl.signal,
    });
    if (!streamRes.ok) throw new Error("Stream " + streamRes.status);
    const sseText = await streamRes.text();

    let audioUrl = "";
    for (const line of sseText.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const parsed = JSON.parse(line.slice(6));
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (item && item.url) {
        audioUrl = item.url.startsWith("http") ? item.url : space + item.url;
      } else if (typeof item === "string" && (item.startsWith("http") || item.startsWith("/"))) {
        audioUrl = item.startsWith("http") ? item : space + item;
      }
    }
    if (!audioUrl) throw new Error("No audio URL in SSE");

    const fileRes = await fetch(audioUrl, { signal: ctl.signal });
    if (!fileRes.ok) throw new Error("File " + fileRes.status);

    return {
      buffer: await fileRes.arrayBuffer(),
      type: fileRes.headers.get("content-type") || "audio/wav",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleFallback(text) {
  const host = ["translate", "google", "com"].join(".");
  const ttsUrl =
    "https://" +
    host +
    "/translate_tts?ie=UTF-8&q=" +
    encodeURIComponent(text.slice(0, 180)) +
    "&tl=ru&client=tw-ob";
  const res = await fetch(ttsUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://" + host + "/",
    },
  });
  if (!res.ok) throw new Error("Google fallback " + res.status);
  return { buffer: await res.arrayBuffer(), type: "audio/mpeg" };
}
