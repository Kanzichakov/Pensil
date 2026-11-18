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

      const audio = await fetchAnyRunningSilero(text, speaker).catch(() => fetchGoogleFallback(text));

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

async function findRunningSileroSpaces() {
  const dom = ["hf", "space"].join(".");
  const priorityList = [
    "https://" + ["andreyboy", "silero", "tts", "mcp"].join("-") + "." + dom,
  ];

  try {
    const api = "https://" + ["huggingface", "co"].join(".") + "/api/spaces?search=silero%20tts&sort=likes&limit=15";
    const res = await fetch(api);
    if (!res.ok) return priorityList;
    const list = await res.json();
    const found = [];
    for (const item of list) {
      if (!item || !item.id) continue;
      if (item.runtime && item.runtime.stage && item.runtime.stage !== "RUNNING") continue;
      const slug = item.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      found.push("https://" + slug + "." + dom);
    }
    return [...new Set([...priorityList, ...found])];
  } catch {
    return priorityList;
  }
}

async function debugSilero() {
  const spaces = await findRunningSileroSpaces();
  const logs = ["[v2] Проверка живых Space (" + spaces.length + "):"];
  for (const space of spaces.slice(0, 4)) {
    try {
      const audio = await trySpaceSynthesize(space, "Привет, проверка живого голоса", "baya");
      logs.push("УСПЕХ на " + space + " -> WAV " + audio.buffer.byteLength + " байт!");
      return logs.join("\n");
    } catch (e) {
      logs.push("Сбой " + space + ":\n" + (e.message || e));
    }
  }
  return logs.join("\n\n");
}

async function fetchAnyRunningSilero(text, speaker) {
  const spaces = await findRunningSileroSpaces();
  let lastErr;
  for (const space of spaces.slice(0, 4)) {
    try {
      return await trySpaceSynthesize(space, text, speaker);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No running Silero spaces");
}

function findAudioUrlDeep(node, space) {
  if (!node) return "";
  if (typeof node === "string") {
    if (node.startsWith("data:audio/")) return node;
    if (node.startsWith("http://") || node.startsWith("https://")) return node;
    if (node.startsWith("/") && (node.includes("file=") || /\.(wav|mp3|ogg|flac)(\?|$)/i.test(node))) {
      return space + node;
    }
    return "";
  }
  if (Array.isArray(node)) {
    for (const el of node) {
      const found = findAudioUrlDeep(el, space);
      if (found) return found;
    }
    return "";
  }
  if (typeof node === "object") {
    if (typeof node.url === "string") {
      const u = findAudioUrlDeep(node.url, space);
      if (u) return u;
    }
    if (typeof node.path === "string") {
      return node.path.startsWith("http") ? node.path : space + "/gradio_api/file=" + node.path;
    }
    for (const val of Object.values(node)) {
      const found = findAudioUrlDeep(val, space);
      if (found) return found;
    }
  }
  return "";
}

async function trySpaceSynthesize(space, text, speaker) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 14000);

  try {
    let fnName = "predict";
    let payloadData = [text, speaker, 48000];
    let apiMode = "gradio5";
    let epDebug = "";

    const infoRes = await fetch(space + "/gradio_api/info", { signal: ctl.signal }).catch(() => null);
    if (infoRes && infoRes.ok) {
      const info = await infoRes.json().catch(() => null);
      const endpoints = info && info.named_endpoints ? Object.keys(info.named_endpoints) : [];
      epDebug = "endpoints=" + JSON.stringify(endpoints);
      if (endpoints.length > 0) {
        const ttsEp = endpoints.find((k) => /tts|synth|gen|speak|voice/i.test(k)) || endpoints.at(0);
        fnName = ttsEp.replace(/^\//, "");
        const params = info.named_endpoints[ttsEp].parameters || [];
        epDebug += " | chosen=" + ttsEp + " | params=" + JSON.stringify(params.map((p) => p.parameter_name || p.label));
        payloadData = buildArgs(params, text, speaker);
      }
    } else {
      const info4 = await fetch(space + "/info", { signal: ctl.signal }).catch(() => null);
      if (info4 && info4.ok) {
        apiMode = "gradio4";
        const info = await info4.json().catch(() => null);
        const endpoints = info && info.named_endpoints ? Object.keys(info.named_endpoints) : [];
        epDebug = "g4_endpoints=" + JSON.stringify(endpoints);
        if (endpoints.length > 0) {
          const ttsEp = endpoints.find((k) => /tts|synth|gen|speak|voice/i.test(k)) || endpoints.at(0);
          fnName = ttsEp.replace(/^\//, "");
          const params = info.named_endpoints[ttsEp].parameters || [];
          payloadData = buildArgs(params, text, speaker);
        }
      } else {
        throw new Error("Space offline or 404");
      }
    }

    const basePrefix = apiMode === "gradio5" ? "/gradio_api/call/" : "/call/";
    const startRes = await fetch(space + basePrefix + fnName, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: payloadData }),
      signal: ctl.signal,
    });
    if (!startRes.ok) throw new Error("Start " + startRes.status + " (" + epDebug + ")");
    const { event_id } = await startRes.json();
    if (!event_id) throw new Error("No event_id (" + epDebug + ")");

    const streamRes = await fetch(space + basePrefix + fnName + "/" + event_id, {
      signal: ctl.signal,
    });
    if (!streamRes.ok) throw new Error("Stream " + streamRes.status);
    const sseText = await streamRes.text();

    let audioUrl = "";
    for (const line of sseText.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const parsed = JSON.parse(line.slice(6));
      audioUrl = findAudioUrlDeep(parsed, space);
      if (audioUrl) break;
    }
    if (!audioUrl) {
      throw new Error("No audio URL in SSE | " + epDebug + " | SSE=" + sseText.slice(0, 400));
    }

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

function buildArgs(params, text, speaker) {
  if (!Array.isArray(params) || params.length === 0) return [text, speaker, 48000];
  return params.map((p, idx) => {
    const label = String((p && (p.parameter_name || p.label)) || "").toLowerCase();
    if (idx === 0 || label.includes("text") || label.includes("текст")) return text;
    if (label.includes("lang") || label.includes("язык")) return "ru";
    if (label.includes("model") || label.includes("модел")) return "v4_ru";
    if (label.includes("speaker") || label.includes("voice") || label.includes("голос") || label.includes("спикер")) return speaker;
    if (label.includes("rate") || label.includes("sample") || label.includes("частот")) return 48000;
    if (p && p.parameter_default !== undefined) return p.parameter_default;
    return speaker;
  });
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
