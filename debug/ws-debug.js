const query = new URLSearchParams(location.search);
const defaultWsUrl =
  query.get('ws') ||
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

const $ = (id) => document.getElementById(id);

const wsUrlInput = $('wsUrl');
const systemPromptInput = $('systemPrompt');
const kickoffInput = $('kickoff');
const logEl = $('log');
const btnConnect = $('btnConnect');
const btnSend = $('btnSend');
const btnClose = $('btnClose');
const btnClear = $('btnClear');

const MODEL = 'models/gemini-3.1-flash-live-preview';

let ws = null;
let setupComplete = false;

wsUrlInput.value = defaultWsUrl;

function timestamp() {
  return new Date().toLocaleTimeString();
}

function writeLog(line) {
  logEl.value += `[${timestamp()}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function prettyPayload(payload) {
  if (typeof payload !== 'string') return String(payload);
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

function setButtons() {
  const isOpen = ws?.readyState === WebSocket.OPEN;
  btnConnect.disabled = isOpen;
  btnSend.disabled = !isOpen || !setupComplete;
  btnClose.disabled = !ws || ws.readyState >= WebSocket.CLOSING;
}

function sendJson(label, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const raw = JSON.stringify(data);
  writeLog(`${label}\n${prettyPayload(raw)}`);
  ws.send(raw);
}

function sendSetup() {
  sendJson('OUT setup', {
    setup: {
      model: MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: systemPromptInput.value }],
      },
      tools: [{
        functionDeclarations: [
          {
            name: 'mark_word_found',
            description: 'Use this silently every time the user correctly guesses a new bingo word. Never say the tool name aloud.',
            parameters: {
              type: 'object',
              properties: {
                word: { type: 'string', description: 'The correctly guessed word in uppercase' },
              },
              required: ['word'],
            },
          },
        ],
      }],
    },
  });
}

function sendKickoff() {
  sendJson('OUT realtimeInput', {
    realtimeInput: {
      text: kickoffInput.value,
    },
  });
}

async function decodeMessage(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return await data.text();
  return String(data);
}

function connect() {
  if (ws && ws.readyState < WebSocket.CLOSING) {
    writeLog('Socket already open or connecting.');
    return;
  }

  setupComplete = false;
  ws = new WebSocket(wsUrlInput.value);
  ws.binaryType = 'arraybuffer';
  setButtons();
  writeLog(`CONNECT ${wsUrlInput.value}`);

  ws.onopen = () => {
    writeLog('OPEN');
    sendSetup();
    setButtons();
  };

  ws.onmessage = async (event) => {
    const raw = await decodeMessage(event.data);
    writeLog(`IN message\n${prettyPayload(raw)}`);

    try {
      const parsed = JSON.parse(raw);
      if (parsed.setupComplete && !setupComplete) {
        setupComplete = true;
        writeLog('SETUP COMPLETE');
        sendKickoff();
      }
      if (parsed.toolCall?.functionCalls?.length) {
        const functionResponses = parsed.toolCall.functionCalls.map((fc) => ({
          id: fc.id,
          name: fc.name,
          response: { result: 'ok' },
        }));
        writeLog(`TOOL CALLS ${JSON.stringify(parsed.toolCall.functionCalls, null, 2)}`);
        sendJson('OUT toolResponse', {
          toolResponse: {
            functionResponses,
          },
        });
      }
    } catch {
      // Keep raw logs even when frames are not valid JSON.
    }

    setButtons();
  };

  ws.onerror = () => {
    writeLog('ERROR WebSocket error event fired');
  };

  ws.onclose = (event) => {
    writeLog(`CLOSE code=${event.code} reason=${event.reason || '(none)'} clean=${event.wasClean}`);
    ws = null;
    setupComplete = false;
    setButtons();
  };
}

btnConnect.addEventListener('click', connect);
btnSend.addEventListener('click', sendKickoff);
btnClose.addEventListener('click', () => {
  if (!ws) return;
  writeLog('OUT close request');
  ws.close();
  setButtons();
});
btnClear.addEventListener('click', () => {
  logEl.value = '';
});

setButtons();
writeLog('Ready.');
