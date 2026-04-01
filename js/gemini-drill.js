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
        return this._handleWordFound(args.word);
      } else if (name === 'report_incorrect_guess') {
        return this._handleIncorrectGuess(args.heard);
      } else if (name === 'end_challenge') {
        return this._handleEndChallenge(args.reason);
      } else if (name === 'advance_to_next_challenge') {
        return this._handleAdvanceToNextChallenge();
      }

      return { status: 'ignored' };
    };

    this._session.onError = (err) => {
      this._emitUiUpdate({ statusText: `Connection error: ${err.message}`, clearHeard: true });
    };

    this._session.onDisconnect = (info) => {
      console.log('GeminiDrill: onDisconnect fired', info || null);
      this.onFallbackToOffline?.();
    };

    const prompt = buildChallengePrompt(
      this.state.current.stem,
      this.state.current.letter,
      targets,
      found,
      this.state.current.pendingAdvanceReason
    );

    console.log('GeminiDrill: connecting...');
    await this._session.connect(prompt);
    console.log('GeminiDrill: connected, starting capture...');
    await this._capture.start();
    console.log('GeminiDrill: capture started, sending kick-off text...');
    this._capture.onChunk = (b64) => this._session?.sendAudio(b64);
    if (this.state.awaitingAdvance) {
      this._session.sendText('We are waiting after the recap. Briefly remind the user to say ready when they want the next challenge.');
    } else {
      this._session.sendText('Start the drill. Announce the stem and letter.');
    }
    console.log('GeminiDrill: session fully open');
  }

  _closeSession() {
    this._capture?.stop();
    this._capture = null;
    if (this._session) this._session.onDisconnect = null;
    this._session?.disconnect();
    this._session = null;
  }

  _emitUiUpdate(update) {
    this.onUiUpdate?.(update);
  }

  _recapStatusText() {
    const recap = this.state.getRecap();
    if (!recap) return 'Say ready when you want the next challenge.';
    return `Recap: ${recap.allWords.join(', ')}\nSay ready when you want the next challenge.`;
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
      this.state.beginChallengeEnd('complete');
    }

    return {
      status: result,
      word,
      remainingCount: this.state.remainingCount,
      foundCount: this.state.foundCount,
    };
  }

  _handleIncorrectGuess(heard) {
    const text = String(heard || '').trim();
    if (!text) return { status: 'ignored' };
    this._emitUiUpdate({ heardText: text });
    return { status: 'ok', heard: text };
  }

  _handleEndChallenge(reason) {
    const normalized = String(reason || 'other').trim().toLowerCase() || 'other';
    if (normalized === 'skip') {
      return this._handleAdvanceToNextChallenge(true);
    }
    this.state.beginChallengeEnd(normalized);
    this._emitUiUpdate({
      statusText: this._recapStatusText(),
      clearHeard: true,
    });
    return { status: 'ok', reason: normalized, awaitingAdvance: true };
  }

  async _nextChallenge() {
    this._closeSession();
    this.state.next();
    this._emitUiUpdate({
      statusText: this.state.promptText,
      clearHeard: true,
    });
    await this._openSession();
    this._advancing = false;
  }

  _handleAdvanceToNextChallenge(force = false) {
    if ((!this.state.awaitingAdvance && !force) || this._advancing) {
      return { status: 'ignored' };
    }
    this._advancing = true;
    setTimeout(() => {
      this._nextChallenge().catch((err) => {
        this._advancing = false;
        this._emitUiUpdate({
          statusText: `Connection error: ${err.message}`,
          clearHeard: true,
        });
      });
    }, 0);
    return { status: 'ok', advancing: true };
  }

  doHint() {
    if (this.state.awaitingAdvance) {
      this._session?.sendText('We are still waiting after the recap. Briefly remind the user to say ready when they want the next challenge.');
      return;
    }

    const hint = this.state.advanceHint();
    if (!hint) return;

    if (hint.autoComplete) {
      const status = this.state.markFound(hint.word);

      if (status === 'correct' && this.state.allFound) {
        this.state.beginChallengeEnd('complete');
        this._emitUiUpdate({
          statusText: this._recapStatusText(),
          clearHeard: true,
        });
        this._session?.sendText(
          `The hinted word ${hint.word} was just marked complete and the challenge is now finished. Briefly congratulate the user, recap all valid words, and ask them to say ready when they want the next challenge.`
        );
        return;
      }

      this._emitUiUpdate({
        statusText: `${hint.word}: ${status} (hint)`,
        clearHeard: true,
      });
      this._session?.sendText(
        `Give this exact hint and nothing else: "The word is ${hint.word}."`
      );
      return;
    }

    this._emitUiUpdate({
      statusText: `Hint: ${hint.text}`,
      clearHeard: true,
    });
    this._session?.sendText(
      `Give this exact hint and nothing else: "${hint.text}"`
    );
  }

  async doSkip() {
    if (this.state.awaitingAdvance) return;
    this._handleAdvanceToNextChallenge(true);
  }
}
