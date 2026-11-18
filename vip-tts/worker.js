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
        return new Response(await debugSilero(), {
          headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      let text = "", voice = "svetlana";
      if (req.method === "GET") {
        text = url.searchParams.get("text") || url.searchParams.get("input") || "";
        voice = url.searchParams.get("voice") || "svetlana";
      } else if (req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        text = b.input || b.text || "";
        voice = b.voice || "svetlana";
      }

      text = String(text)
        .replace(/\*[^*]*\*/g, " ")
        .replace(/[*_~`#>]+/g, " ")
        .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f]/gu, " ")
        .replace(/\s+/g, " ").trim().slice(0, 700);
      if (!text) return new Response("Empty text", { status: 400, headers: cors });

      const v = String(voice).toLowerCase();
      const spk = v.includes("dariya") || v.includes("baya") ? "baya" : (v.includes("elena") || v.includes("xenia") ? "xenia" : "kseniya");

      const audio = await fetchAnySilero(text, spk).catch(() => fetchGoogle(text));
      return new Response(audio.buffer, {
        headers: { ...cors, "Content-Type": audio.type, "Cache-Control": "no-store" },
      });
    } catch (e) {
      return new Response(String(e.message || e), { status: 500, headers: cors });
    }
  },
};

async function findSpaces() {
  const dom = ["hf", "space"].join("."), hf = ["huggingface", "co"].join(".");
  const found = [];
  for (const q of ["silero%20tts", "silero%20russian"]) {
    try {
      const r = await fetch(`https://${hf}/api/spaces?search=${q}&sort=lastModified&direction=-1&limit=20`);
      if (!r.ok) continue;
      for (const it of await r.json()) {
        if (!it?.id || (it.runtime?.stage && it.runtime.stage !== "RUNNING")) continue;
        found.push(`https://${it.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.${dom}`);
      }
    } catch {}
  }
  found.push("https://" + ["neurosenko", "tts", "silero"].join("-") + "." + dom);
  return [...new Set(found)];
}

async function debugSilero() {
  const spaces = await findSpaces(), out = [`[v3] Кандидатов (${spaces.length}):`];
  for (const s of spaces.slice(0, 12)) {
    try {
      const a = await trySpace(s, "Привет, проверка живого голоса", "baya");
      return [...out, `УСПЕХ: ${s} -> ${a.type} (${a.buffer.byteLength} байт)`].join("\n");
    } catch (e) { out.push(`Сбой ${s}: ${e.message || e}`); }
  }
  return out.join("\n");
}

async function fetchAnySilero(text, spk) {
  let err;
  for (const s of (await findSpaces()).slice(0, 10)) {
    try { return await trySpace(s, text, spk); } catch (e) { err = e; }
  }
  throw err || new Error("No spaces");
}

function findUrl(n, s) {
  if (!n) return "";
  if (typeof n === "string") {
    if (n.startsWith("data:audio/") || n.startsWith("http")) return n;
    if (n.startsWith("/") && (n.includes("file=") || /\.(wav|mp3|ogg)(\?|$)/i.test(n))) return s + n;
    return "";
  }
  if (Array.isArray(n)) { for (const x of n) { const u = findUrl(x, s); if (u) return u; } return ""; }
  if (typeof n === "object") {
    if (typeof n.url === "string") { const u = findUrl(n.url, s); if (u) return u; }
    if (typeof n.path === "string") return n.path.startsWith("http") ? n.path : `${s}/file=${n.path}`;
    for (const v of Object.values(n)) { const u = findUrl(v, s); if (u) return u; }
  }
  return "";
}

async function trySpace(space, text, spk) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
  try {
    let mode = "", info = null;
    const r5 = await fetch(space + "/gradio_api/info", { signal: ctl.signal }).catch(() => null);
    if (r5?.ok) { mode = "g5"; info = await r5.json().catch(() => null); }
    else {
      const r4 = await fetch(space + "/info", { signal: ctl.signal }).catch(() => null);
      if (r4?.ok) { mode = "g4"; info = await r4.json().catch(() => null); }
    }
    if (!mode || !info) throw new Error("offline");

    const named = Object.keys(info.named_endpoints || {});
    const unnamed = Object.keys(info.unnamed_endpoints || {});
    const targets = [];
    if (named.length) {
      const ep = named.find(k => /tts|synth|gen|speak|voice/i.test(k)) || named[0];
      targets.push({ name: ep.replace(/^\//, ""), args: buildArgs(info.named_endpoints[ep].parameters, text, spk), idx: 0 });
    }
    if (unnamed.length) {
      const k = unnamed[0];
      targets.push({ name: String(k), args: buildArgs(info.unnamed_endpoints[k].parameters, text, spk), idx: Number(k) || 0 });
    }
    if (!targets.length) targets.push({ name: "predict", args: [text, spk, 48000], idx: 0 });

    const pref = mode === "g5" ? "/gradio_api/call/" : "/call/";
    let err = "no target";
    for (const tg of targets) {
      const st = await fetch(space + pref + tg.name, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: tg.args }), signal: ctl.signal,
      }).catch(() => null);
      if (st?.ok) {
        const { event_id } = await st.json().catch(() => ({}));
        if (event_id) {
          const sr = await fetch(`${space}${pref}${tg.name}/${event_id}`, { signal: ctl.signal });
          if (sr.ok) {
            const sse = await sr.text();
            for (const line of sse.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const u = findUrl(JSON.parse(line.slice(6)), space);
              if (u) {
                const f = await fetch(u, { signal: ctl.signal });
                if (f.ok) return { buffer: await f.arrayBuffer(), type: f.headers.get("content-type") || "audio/wav" };
              }
            }
            err = "SSE empty";
          }
        }
      }
      const runUrl = mode === "g5" ? `${space}/gradio_api/run/predict` : `${space}/run/predict`;
      const rr = await fetch(runUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fn_index: tg.idx, data: tg.args }), signal: ctl.signal,
      }).catch(() => null);
      if (rr?.ok) {
        const u = findUrl(await rr.json().catch(() => null), space);
        if (u) {
          const f = await fetch(u, { signal: ctl.signal });
          if (f.ok) return { buffer: await f.arrayBuffer(), type: f.headers.get("content-type") || "audio/wav" };
        }
        err = "run/predict empty";
      } else if (rr) err = `run ${rr.status}`;
    }
    throw new Error(err);
  } finally { clearTimeout(t); }
}

function buildArgs(params, text, spk) {
  if (!Array.isArray(params) || !params.length) return [text, spk, 48000];
  return params.map((p, i) => {
    const l = String(p?.parameter_name || p?.label || "").toLowerCase();
    if (i === 0 || /text|текст/.test(l)) return text;
    if (/lang|язык/.test(l)) return "ru";
    if (/model|модел/.test(l)) return "v4_ru";
    if (/speaker|voice|голос|спикер/.test(l)) return spk;
    if (/rate|sample|частот/.test(l)) return 48000;
    return p?.parameter_default !== undefined ? p.parameter_default : spk;
  });
}

async function fetchGoogle(text) {
  const h = ["translate", "google", "com"].join(".");
  const r = await fetch(`https://${h}/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 180))}&tl=ru&client=tw-ob`, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: `https://${h}/` },
  });
  if (!r.ok) throw new Error(`Google ${r.status}`);
  return { buffer: await r.arrayBuffer(), type: "audio/mpeg" };
}
