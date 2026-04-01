const MODEL = 'models/gemini-3.1-flash-live-preview';

export class GeminiSession {
  constructor(workerUrl) {
    this._workerUrl = workerUrl;
    this._ws = null;
    this._setupResolve = null;
    this._setupReject = null;

    this.onAudio = null;       // (base64: string) => void
    this.onText = null;        // (text: string) => void
    this.onToolCall = null;    // (name: string, args: object) => void
    this.onError = null;       // (error: Error) => void
    this.onDisconnect = null;  // (info?: { code: number, reason: string, wasClean: boolean }) => void
  }

  get connected() {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  connect(systemPrompt) {
    return new Promise((resolve, reject) => {
      this._setupResolve = resolve;
      this._setupReject = reject;

      try {
        this._ws = new WebSocket(this._workerUrl);
        this._ws.binaryType = 'arraybuffer';
      } catch (e) {
        reject(e);
        return;
      }

      this._ws.onopen = () => {
        console.log('[GeminiSession] socket open', this._workerUrl);
        this._sendSetup(systemPrompt);
      };

      this._ws.onmessage = async (e) => {
        let data;
        if (typeof e.data === 'string') {
          data = e.data;
        } else if (e.data instanceof ArrayBuffer) {
          data = new TextDecoder().decode(e.data);
        } else if (e.data instanceof Blob) {
          data = await e.data.text();
        } else {
          data = String(e.data);
        }
        console.log('[GeminiSession] inbound frame', {
          type: typeof e.data === 'string' ? 'string' : e.data?.constructor?.name || typeof e.data,
          length: data.length,
        });
        this._handleMessage(data);
      };

      this._ws.onerror = () => {
        const err = new Error('WebSocket error');
        console.error('[GeminiSession] socket error');
        if (this._setupReject) {
          this._setupReject(err);
          this._setupResolve = null;
          this._setupReject = null;
        }
        this.onError?.(err);
      };

      this._ws.onclose = (e) => {
        console.log('[GeminiSession] socket close', {
          code: e.code,
          reason: e.reason,
          wasClean: e.wasClean,
        });
        if (this._setupReject) {
          this._setupReject(new Error('Connection closed before setup'));
          this._setupResolve = null;
          this._setupReject = null;
        }
        this.onDisconnect?.({
          code: e.code,
          reason: e.reason,
          wasClean: e.wasClean,
        });
      };
    });
  }

  _sendSetup(systemPrompt) {
    const setup = {
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
          parts: [{ text: systemPrompt }],
        },
        tools: [{
          functionDeclarations: [
            {
              name: 'mark_word_found',
              description: 'Use this silently every time the user correctly guesses a new bingo word. Never say the tool name aloud. The UI updates only from this tool call.',
              parameters: {
                type: 'object',
                properties: {
                  word: { type: 'string', description: 'The correctly guessed word in uppercase' },
                },
                required: ['word'],
              },
            },
            {
              name: 'report_incorrect_guess',
              description: 'Use this silently when the user gives a guess that is not in the target set so the UI can show what you think you heard. Never say the tool name aloud.',
              parameters: {
                type: 'object',
                properties: {
                  heard: { type: 'string', description: 'The word or short phrase you believe the user said' },
                },
                required: ['heard'],
              },
            },
            {
              name: 'end_challenge',
              description: 'Use this silently when the current challenge should end so the app can advance deterministically.',
              parameters: {
                type: 'object',
                properties: {
                  reason: { type: 'string', description: 'Why the challenge is ending: skip, complete, or other short reason' },
                },
                required: ['reason'],
              },
            },
          ],
        }],
      },
    };
    console.log('[GeminiSession] send setup');
    this._ws.send(JSON.stringify(setup));
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Setup complete
    if (msg.setupComplete) {
      console.log('[GeminiSession] setupComplete');
      if (this._setupResolve) {
        this._setupResolve();
        this._setupResolve = null;
        this._setupReject = null;
      }
      return;
    }

    // Server content (audio and/or text)
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.onAudio?.(part.inlineData.data);
        }
        if (part.text) {
          this.onText?.(part.text);
        }
      }
    }

    // Interruption -- server signals it cut off its own output
    if (msg.serverContent?.interrupted) {
      // Caller should flush audio playback
      this.onAudio?.(''); // empty string signals flush
    }

    // Tool calls (function calling)
    if (msg.toolCall?.functionCalls) {
      for (const fc of msg.toolCall.functionCalls) {
        console.log('[GeminiSession] toolCall', {
          name: fc.name,
          id: fc.id,
          args: fc.args || {},
        });
        this.onToolCall?.(fc.name, fc.args || {});
        // Send tool response so Gemini can continue
        const toolResponse = {
          toolResponse: {
            functionResponses: [{
              id: fc.id,
              name: fc.name,
              response: { result: 'ok' },
            }],
          },
        };
        console.log('[GeminiSession] send toolResponse', toolResponse.toolResponse.functionResponses[0]);
        this._ws?.send(JSON.stringify({
          toolResponse: toolResponse.toolResponse,
        }));
      }
    }

    // Go away -- server wants us to disconnect
    if (msg.goAway) {
      this.disconnect();
    }
  }

  sendAudio(base64Chunk) {
    if (!this.connected) return;
    console.log('[GeminiSession] send audio', base64Chunk.length);
    this._ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          data: base64Chunk,
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    }));
  }

  sendText(text) {
    if (!this.connected) return;
    console.log('[GeminiSession] send text', text);
    this._ws.send(JSON.stringify({
      realtimeInput: {
        text,
      },
    }));
  }

  disconnect() {
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }
}
