const GEMINI_WS_URL =
  'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response('GEMINI_API_KEY not configured', { status: 500 });
  }

  // Create client-facing WebSocket pair
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  // Connect upstream to Gemini
  const geminiUrl = `${GEMINI_WS_URL}?key=${apiKey}`;
  const geminiResp = await fetch(geminiUrl, {
    headers: { Upgrade: 'websocket' },
  });

  if (!geminiResp.webSocket) {
    server.close(1011, 'Failed to connect to Gemini');
    return new Response('Failed to connect upstream', { status: 502 });
  }

  const gemini = geminiResp.webSocket;
  gemini.accept();

  // Bidirectional forwarding — Cloudflare delivers WebSocket messages
  // as Blob objects; convert to text so the client receives JSON.
  server.addEventListener('message', async (e) => {
    try {
      const msg = typeof e.data === 'string' ? e.data : await e.data.text();
      gemini.send(msg);
    } catch {}
  });
  gemini.addEventListener('message', async (e) => {
    try {
      const msg = typeof e.data === 'string' ? e.data : await e.data.text();
      server.send(msg);
    } catch {}
  });

  server.addEventListener('close', (e) => {
    try { gemini.close(e.code, e.reason); } catch {}
  });
  gemini.addEventListener('close', (e) => {
    try { server.close(e.code, e.reason); } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}
