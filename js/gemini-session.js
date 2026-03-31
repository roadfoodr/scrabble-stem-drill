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
    this.onDisconnect = null;  // () => void
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
        this._sendSetup(systemPrompt);
      };

      this._ws.onmessage = (e) => {
        const data = e.data instanceof ArrayBuffer
          ? new TextDecoder().decode(e.data)
          : e.data;
        this._handleMessage(data);
      };

      this._ws.onerror = () => {
        const err = new Error('WebSocket error');
        if (this._setupReject) {
          this._setupReject(err);
          this._setupResolve = null;
          this._setupReject = null;
        }
        this.onError?.(err);
      };

      this._ws.onclose = () => {
        if (this._setupReject) {
          this._setupReject(new Error('Connection closed before setup'));
          this._setupResolve = null;
          this._setupReject = null;
        }
        this.onDisconnect?.();
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
              description: 'Call this every time the user correctly guesses a bingo word. The UI depends on this call.',
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
    };
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
        this.onToolCall?.(fc.name, fc.args || {});
        // Send tool response so Gemini can continue
        this._ws?.send(JSON.stringify({
          toolResponse: {
            functionResponses: [{
              id: fc.id,
              response: { result: 'ok' },
            }],
          },
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
    this._ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
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
