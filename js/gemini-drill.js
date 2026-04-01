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
    this._advanceTimer = null;

    this.onUiUpdate = null;            // ({ statusText?: string, heardText?: string, clearHeard?: boolean }) => void
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
      } else if (name === 'report_incorrect_guess') {
        this._handleIncorrectGuess(args.heard);
      } else if (name === 'end_challenge') {
        this._handleEndChallenge(args.reason);
      }
    };

    this._session.onError = (err) => {
      this._emitUiUpdate({ statusText: `Connection error: ${err.message}`, clearHeard: true });
    };

    this._session.onDisconnect = (info) => {
      console.log('GeminiDrill: onDisconnect fired, advancing:', this._advancing, info || null);
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

    console.log('GeminiDrill: connecting...');
    await this._session.connect(prompt);
    console.log('GeminiDrill: connected, starting capture...');
    await this._capture.start();
    console.log('GeminiDrill: capture started, sending kick-off text...');
    this._capture.onChunk = (b64) => this._session?.sendAudio(b64);
    this._session.sendText('Start the drill. Announce the stem and letter.');
    console.log('GeminiDrill: session fully open');
  }

  _closeSession() {
    this._clearAdvanceTimer();
    this._capture?.stop();
    this._capture = null;
    if (this._session) this._session.onDisconnect = null;
    this._session?.disconnect();
    this._session = null;
  }

  _emitUiUpdate(update) {
    this.onUiUpdate?.(update);
  }

  _clearAdvanceTimer() {
    if (this._advanceTimer) {
      clearTimeout(this._advanceTimer);
      this._advanceTimer = null;
    }
  }

  _handleWordFound(word) {
    const result = this.state.markFound(word);
    this._emitUiUpdate({
      statusText: `${word}: ${result}`,
      clearHeard: true,
    });

    if (result !== 'correct') {
      return;
    }

    if (this.state.allFound) {
      this._scheduleChallengeAdvance('complete', 3000);
    }
  }

  _handleIncorrectGuess(heard) {
    const text = String(heard || '').trim();
    if (!text) return;
    this._emitUiUpdate({ heardText: text });
  }

  _handleEndChallenge(reason) {
    const normalized = String(reason || 'other').trim().toLowerCase() || 'other';
    const delayMs = normalized === 'complete' ? 3000 : 0;
    this._scheduleChallengeAdvance(normalized, delayMs);
  }

  _scheduleChallengeAdvance(reason, delayMs) {
    if (this._advancing) return;

    this._advancing = true;
    this._clearAdvanceTimer();
    this._advanceTimer = setTimeout(() => {
      this._advanceTimer = null;
      this._nextChallenge(reason);
    }, delayMs);
  }

  async _nextChallenge(reason = 'other') {
    this._closeSession();
    this.state.next();
    this._emitUiUpdate({
      statusText: reason === 'skip' ? `Skipped. ${this.state.promptText}` : this.state.promptText,
      clearHeard: true,
    });
    this._advancing = false;
    await this._openSession();
  }

  doHint() {
    this._session?.sendText('hint');
  }

  async doSkip() {
    this._scheduleChallengeAdvance('skip', 0);
  }
}
