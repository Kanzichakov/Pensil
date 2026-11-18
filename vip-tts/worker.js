export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('OK', { headers: cors });

    try {
      const { input = '', voice = 'ru-RU-SvetlanaNeural', speed = 1, pitch = 1 } = await request.json();
      const text = String(input).replace(/[<>&"']/g, ' ').trim();
      if (!text) return new Response('Empty text', { status: 400, headers: cors });

      const ratePct = `${speed >= 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;
      const pitchHz = `${pitch >= 1 ? '+' : ''}${Math.round((pitch - 1) * 40)}Hz`;
      const reqId = crypto.randomUUID().replace(/-/g, '');
      const ts = new Date().toISOString();

      const host = ['speech', 'platform', 'bing', 'com'].join('.');
      const path = '/consumer/speech/synthesize/readaloud/edge/v1';
      const token = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
      const url = `https://${host}${path}?TrustedClientToken=${token}`;

      const resp = await fetch(url, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': btoa(reqId.slice(0, 16)),
          'Sec-WebSocket-Version': '13',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
        }
      });

      const ws = resp.webSocket;
      if (!ws) return new Response('WS failed', { status: 502, headers: cors });
      ws.accept();

      const audioChunks = [];
      await new Promise((resolve, reject) => {
        ws.addEventListener('message', e => {
          if (typeof e.data === 'string') {
            if (e.data.includes('Path:turn.end')) { ws.close(); resolve(); }
          } else {
            const buf = new Uint8Array(e.data);
            const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            const hdrLen = view.getUint16(0, false);
            audioChunks.push(buf.slice(2 + hdrLen));
          }
        });
        ws.addEventListener('error', reject);

        ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
        const ns = 'http://' + ['www', 'w3', 'org'].join('.') + '/2001/10/synthesis';
        ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='${ns}' xml:lang='ru-RU'><voice name='${voice}'><prosody rate='${ratePct}' pitch='${pitchHz}'>${text}</prosody></voice></speak>`);
        });

      return new Response(new Blob(audioChunks, { type: 'audio/mpeg' }), {
        headers: { ...cors, 'Content-Type': 'audio/mpeg' }
      });
    } catch (e) {
      return new Response(e.message, { status: 500, headers: cors });
    }
  }
};
    