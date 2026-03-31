const GEMINI_WS_URL =
  'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function describeData(data) {
  if (typeof data === 'string') return `string(${data.length})`;
  if (data instanceof ArrayBuffer) return `arraybuffer(${data.byteLength})`;
  if (data?.size != null) return `blob(${data.size})`;
  return typeof data;
}

async function normalizeData(data) {
  if (typeof data === 'string' || data instanceof ArrayBuffer) return data;
  if (data?.arrayBuffer) return await data.arrayBuffer();
  return String(data);
}

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  console.log('[ws] request start', {
    upgrade: request.headers.get('Upgrade'),
    url: request.url,
  });

  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[ws] GEMINI_API_KEY missing');
    return new Response('GEMINI_API_KEY not configured', { status: 500 });
  }

  // Create client-facing WebSocket pair
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  try {
    // Connect upstream to Gemini
    const geminiUrl = `${GEMINI_WS_URL}?key=${apiKey}`;
    console.log('[ws] connecting upstream');
    const geminiResp = await fetch(geminiUrl, {
      headers: { Upgrade: 'websocket' },
    });
    console.log('[ws] upstream response', {
      status: geminiResp.status,
      hasWebSocket: !!geminiResp.webSocket,
    });

    if (!geminiResp.webSocket) {
      console.error('[ws] upstream websocket missing');
      server.close(1011, 'Failed to connect to Gemini');
      return new Response('Failed to connect upstream', { status: 502 });
    }

    const gemini = geminiResp.webSocket;
    gemini.accept();
    console.log('[ws] upstream accepted');

    // Keep the Worker context alive for the duration of the WebSocket session.
    // Without this, async event handlers die after the function returns.
    const sessionDone = new Promise((resolve) => {
      server.addEventListener('close', resolve);
      gemini.addEventListener('close', resolve);
    });
    waitUntil(sessionDone);

    // Bidirectional forwarding — Cloudflare delivers messages as Blobs.
    // Convert to ArrayBuffer so raw bytes are transmitted.
    server.addEventListener('message', async (e) => {
      try {
        console.log('[ws] client->gemini', describeData(e.data));
        const data = await normalizeData(e.data);
        gemini.send(data);
      } catch (err) {
        console.error('[ws] client->gemini failed', String(err));
      }
    });
    gemini.addEventListener('message', async (e) => {
      try {
        console.log('[ws] gemini->client', describeData(e.data));
        const data = await normalizeData(e.data);
        server.send(data);
      } catch (err) {
        console.error('[ws] gemini->client failed', String(err));
      }
    });

    server.addEventListener('close', (e) => {
      console.log('[ws] client close', { code: e.code, reason: e.reason });
      try { gemini.close(e.code, e.reason); } catch {}
    });
    gemini.addEventListener('close', (e) => {
      console.log('[ws] gemini close', { code: e.code, reason: e.reason });
      try { server.close(e.code, e.reason); } catch {}
    });

    return new Response(null, { status: 101, webSocket: client });
  } catch (err) {
    console.error('[ws] unhandled proxy error', err && err.stack ? err.stack : String(err));
    try { server.close(1011, 'Proxy exception'); } catch {}
    return new Response('Proxy exception', { status: 500 });
  }
}
