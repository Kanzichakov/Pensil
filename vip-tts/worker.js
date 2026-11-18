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
        const buf = await synthEdge("Привет, проверка живого нейросетевого голоса!", "ru-RU-SvetlanaNeural");
        return new Response(`[v5 Edge-TTS] УСПЕХ: MP3 ${buf.byteLength} байт`, {
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

      const buf = await synthEdge(text, edgeVoice).catch(() => fetchGoogle(text));
      return new Response(buf, {
        headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      });
    } catch (e) {
      return new Response(String(e.message || e), { status: 500, headers: cors });
    }
  },
};

async function synthEdge(text, voice) {
  const token = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const connId = crypto.randomUUID().replace(/-/g, "");
  const muid = crypto.randomUUID().replace(/-/g, "").toUpperCase();
  const secMs = await makeSecMsGec(token);
  const host = ["speech", "platform", "bing", "com"].join(".");
  const path = "/consumer/speech/synthesize/readaloud/edge/v1";
  const wsUrl = `https://${host}${path}?TrustedClientToken=${token}&Sec-MS-GEC=${secMs}&Sec-MS-GEC-Version=1-143.0.3650.75&ConnectionId=${connId}`;

  const resp = await fetch(wsUrl, {
    headers: {
      Upgrade: "websocket",
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      Cookie: `muid=${muid};`,
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
    },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`WS upgrade failed (${resp.status})`);
  ws.accept();

  const ts = new Date().toUTCString();
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ns = "http://" + ["www", "w3", "org"].join(".") + "/2001/10/synthesis";
  const ssml = `<speak version='1.0' xmlns='${ns}' xml:lang='ru-RU'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${safe}</prosody></voice></speak>`;

  ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
  ws.send(`X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Edge WS timeout")); }, 9000);

    ws.addEventListener("message", ev => {
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          const total = chunks.reduce((s, c) => s + c.byteLength, 0);
          if (!total) return reject(new Error("Empty Edge audio"));
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { out.set(c, off); off += c.byteLength; }
          resolve(out.buffer);
        }
      } else if (ev.data instanceof ArrayBuffer) {
        const view = new DataView(ev.data);
        const hdrLen = view.getUint16(0);
        if (ev.data.byteLength > hdrLen + 2) {
          chunks.push(new Uint8Array(ev.data, hdrLen + 2));
        }
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Edge WS error")); });
  });
}

async function makeSecMsGec(token) {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + 11644473600) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n);
  const data = new TextEncoder().encode(`${rounded}${token}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function fetchGoogle(text) {
  const h = ["translate", "google", "com"].join(".");
  const r = await fetch(`https://${h}/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 180))}&tl=ru&client=tw-ob`, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: `https://${h}/` },
  });
  if (!r.ok) throw new Error(`Google ${r.status}`);
  return await r.arrayBuffer();
}
