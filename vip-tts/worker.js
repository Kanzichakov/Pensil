export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      let text = "";
      let voice = "svetlana";

      const url = new URL(request.url);
      if (url.searchParams.has("debug")) {
        const report = await debugSilero();
        return new Response(report, {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

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

      const audio = await fetchSileroSmart(text, speaker).catch(() => fetchGoogleFallback(text));

      return new Response(audio.buffer, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": audio.type,
          "Cache-Control": "no-store",
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

function getSpaceUrl() {
  return "https://" + ["neurosenko", "tts", "silero"].join("-") + "." + ["hf", "space"].join(".");
}

async function debugSilero() {
  const space = getSpaceUrl();
  try {
    const infoRes = await fetch(space + "/gradio_api/info");
    const infoTxt = await infoRes.text();
    const audio = await fetchSileroSmart("Привет, проверка голоса", "baya");
    return "OK! Размер WAV: " + audio.buffer.byteLength + " байт\nINFO: " + infoTxt.slice(0, 500);
  } catch (e) {
    const infoRes = await fetch(space + "/gradio_api/info").catch(() => null);
    const infoTxt = infoRes ? await infoRes.text() : "нет ответа от /gradio_api/info";
    return "ОШИБКА: " + (e.message || e) + "\n\nСХЕМА SPACE:\n" + infoTxt.slice(0, 1200);
  }
}

async function fetchSileroSmart(text, speaker) {
  const space = getSpaceUrl();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);

  try {
    let fnName = "predict";
    let payloadData = [text, speaker, 48000];

    const infoRes = await fetch(space + "/gradio_api/info", { signal: ctl.signal }).catch(() => null);
    if (infoRes && infoRes.ok) {
      const info = await infoRes.json().catch(() => null);
      const endpoints = info && info.named_endpoints ? Object.keys(info.named_endpoints) : [];
      if (endpoints.length > 0) {
        const firstEp = endpoints[0];
        fnName = firstEp.replace(/^\//, "");
        const params = info.named_endpoints[firstEp].parameters || [];
        if (params.length === 4) {
          payloadData = [text, "v4_ru", speaker, 48000];
        } else if (params.length === 2) {
          payloadData = [text, speaker];
        }
      }
    }

    const startRes = await fetch(space + "/gradio_api/call/" + fnName, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: payloadData }),
      signal: ctl.signal,
    });
    if (!startRes.ok) throw new Error("Start " + startRes.status + " on " + fnName);
    const { event_id } = await startRes.json();
    if (!event_id) throw new Error("No event_id");

    const streamRes = await fetch(space + "/gradio_api/call/" + fnName + "/" + event_id, {
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
    if (!audioUrl) throw new Error("No audio URL: " + sseText.slice(0, 200));

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
