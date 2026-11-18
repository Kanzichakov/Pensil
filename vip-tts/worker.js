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
      let lang = "ru";

      const url = new URL(request.url);
      if (request.method === "GET") {
        text = url.searchParams.get("text") || url.searchParams.get("input") || "";
        lang = url.searchParams.get("lang") || "ru";
      } else if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        text = body.input || body.text || "";
        lang = body.lang || "ru";
      }

      text = String(text)
        .replace(/\*[^*]*\*/g, " ")
        .replace(/[*_~`#>]+/g, " ")
        .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!text) {
        return new Response("Empty text", { status: 400, headers: corsHeaders });
      }

      const chunks = splitText(text, 180);
      const buffers = [];
      const host = ["translate", "google", "com"].join(".");

      for (const chunk of chunks) {
        const ttsUrl =
          "https://" +
          host +
          "/translate_tts?ie=UTF-8&q=" +
          encodeURIComponent(chunk) +
          "&tl=" +
          encodeURIComponent(lang) +
          "&client=tw-ob";

        const res = await fetch(ttsUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://" + host + "/",
          },
        });

        if (!res.ok) {
          throw new Error("Google TTS HTTP " + res.status);
        }

        const buf = await res.arrayBuffer();
        buffers.push(new Uint8Array(buf));
      }

      const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const b of buffers) {
        merged.set(b, offset);
        offset += b.length;
      }

      return new Response(merged, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "audio/mpeg",
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

function splitText(text, maxLen) {
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const chunks = [];
  let cur = "";

  for (const part of parts) {
    if ((cur + part).length <= maxLen) {
      cur += part;
    } else {
      if (cur.trim()) chunks.push(cur.trim());
      if (part.length > maxLen) {
        const words = part.split(" ");
        cur = "";
        for (const w of words) {
          if ((cur + " " + w).trim().length <= maxLen) {
            cur = (cur + " " + w).trim();
          } else {
            if (cur) chunks.push(cur);
            cur = w;
          }
        }
      } else {
        cur = part;
      }
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
