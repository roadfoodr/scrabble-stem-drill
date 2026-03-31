import { GeminiSession } from './gemini-session.js';
import { AudioCapture } from './audio-capture.js';
import { AudioPlayback } from './audio-playback.js';
import { buildChallengePrompt } from './system-prompt.js';

export class GeminiDrill {
  constructor(drillState, workerUrl) {
    this.state = drillState;
    this._workerUrl = workerUrl;
    this._session = null;
    this._capture = null;
    this._playback = null;
    this._advancing = false;

    this.onStatusUpdate = null;        // (text: string) => void
    this.onFallbackToOffline = null;   // () => void
  }

  async start() {
    this._playback = new AudioPlayback();
    await this._openSession();
  }

  stop() {
    this._closeSession();
    this._playback?.close();
    this._playback = null;
  }

  async _openSession() {
    const targets = Array.from(this.state.current.targets);
    const found = Array.from(this.state.current.found);

    this._session = new GeminiSession(this._workerUrl);
    this._capture = new AudioCapture();

    this._session.onAudio = (base64) => {
      if (base64 === '') this._playback?.flush();
      else this._playback?.enqueue(base64);
    };

    this._session.onToolCall = (name, args) => {
      if (name === 'mark_word_found') {
        this._handleWordFound(args.word);
      }
    };

    this._session.onError = (err) => {
      this.onStatusUpdate?.(`Connection error: ${err.message}`);
    };

    this._session.onDisconnect = () => {
      if (!this._advancing) {
        this.onFallbackToOffline?.();
      }
    };

    const prompt = buildChallengePrompt(
      this.state.current.stem,
      this.state.current.letter,
      targets,
      found
    );

    try {
      await this._session.connect(prompt);
      await this._capture.start();
      this._capture.onChunk = (b64) => this._session?.sendAudio(b64);
    } catch {
      this.onFallbackToOffline?.();
    }
  }

  _closeSession() {
    this._capture?.stop();
    this._capture = null;
    if (this._session) this._session.onDisconnect = null;
    this._session?.disconnect();
    this._session = null;
  }

  _handleWordFound(word) {
    const result = this.state.markFound(word);
    this.onStatusUpdate?.(`${word}: ${result}`);

    if (this.state.allFound) {
      // Give Gemini time to speak congratulations, then advance
      this._advancing = true;
      setTimeout(() => {
        this._advancing = false;
        this._nextChallenge();
      }, 3000);
    }
  }

  async _nextChallenge() {
    this._closeSession();
    this.state.next();
    this.onStatusUpdate?.(this.state.promptText);
    await this._openSession();
  }

  doHint() {
    this._session?.sendText('hint');
  }

  async doSkip() {
    this._advancing = true;
    this._closeSession();
    this.state.skip();
    this.onStatusUpdate?.(`Skipped. ${this.state.promptText}`);
    this._advancing = false;
    await this._openSession();
  }
}
