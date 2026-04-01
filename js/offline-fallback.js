import { bestMatch } from './fuzzy-match.js';

const SpeechRec = window.webkitSpeechRecognition || window.SpeechRecognition;

export class OfflineFallback {
  constructor(drillState) {
    this.state = drillState;
    this.onStatusUpdate = null; // (text: string) => void
    this._rec = null;
    this._active = false;
    this._ttsEnabled = 'speechSynthesis' in window;
    this._recAvailable = !!SpeechRec;
    this._voice = null;
    this._speaking = false;

    if (this._ttsEnabled) {
      this._voice = this._chooseVoice();
      if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = () => { this._voice = this._chooseVoice(); };
      }
    }
  }

  _chooseVoice() {
    const voices = speechSynthesis.getVoices?.() || [];
    return voices.find(v => /en-US/i.test(v.lang))
      || voices.find(v => /en/i.test(v.lang))
      || voices[0] || null;
  }

  async start() {
    this._active = true;
    if (!this.state.current) {
      this.state.buildQueue();
      this.state.loadPrompt(0);
    }

    if (this.state.awaitingAdvance) {
      const recap = this.state.getRecap();
      this.onStatusUpdate?.(`Recap: ${recap?.allWords.join(', ')}\nSay ready when you want the next challenge.`);
      await this._speak('Offline mode. ' + this._recapPhrase());
    } else {
      await this._speak('Offline mode. ' + this._promptPhrase());
    }

    this._listen();
  }

  stop() {
    this._active = false;
    this._stopListening();
    try { speechSynthesis.cancel(); } catch {}
  }

  _promptPhrase() {
    return `${this.state.current.stem} plus ${this.state.current.letter}. Tell me all the bingos.`;
  }

  _recapPhrase() {
    const recap = this.state.getRecap();
    if (!recap) return 'Say ready when you want the next challenge.';
    return `The valid words are ${recap.allWords.join(', ')}. Say ready when you want the next challenge.`;
  }

  _speak(text) {
    if (!this._ttsEnabled || !text) return Promise.resolve();
    try { speechSynthesis.cancel(); } catch {}
    return new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.0;
      if (this._voice) utter.voice = this._voice;
      this._speaking = true;
      utter.onend = () => { this._speaking = false; resolve(); };
      utter.onerror = () => { this._speaking = false; resolve(); };
      try { speechSynthesis.speak(utter); }
      catch { this._speaking = false; resolve(); }
    });
  }

  _listen() {
    if (!this._active || !this._recAvailable) return;

    if (!this._rec) {
      this._rec = new SpeechRec();
      this._rec.continuous = true;
      this._rec.interimResults = false;
      this._rec.lang = 'en-US';
    }

    this._rec.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript + ' ';
        }
      }
      if (transcript.trim()) {
        this._processTranscript(transcript.trim());
      }
    };

    this._rec.onend = () => {
      // Auto-restart if still active
      if (this._active) {
        try { this._rec.start(); } catch {}
      }
    };

    this._rec.onerror = () => {
      if (this._active) {
        setTimeout(() => { try { this._rec.start(); } catch {} }, 500);
      }
    };

    try { this._rec.start(); } catch {}
  }

  _stopListening() {
    if (this._rec) {
      try { this._rec.stop(); } catch {}
    }
  }

  _extractFragments(norm) {
    const groups = norm.split(/\s+AND\s+/).map(group => group.trim()).filter(Boolean);
    const fragments = [];

    for (const group of groups) {
      const tokens = group.split(/\s+/).map(token => token.replace(/[^A-Z]/g, '')).filter(Boolean);
      let letterBuffer = '';

      for (const token of tokens) {
        if (token.length === 1) {
          letterBuffer += token;
          continue;
        }

        if (letterBuffer.length >= 2) {
          fragments.push(letterBuffer);
        }
        letterBuffer = '';

        if (token.length >= 4) {
          fragments.push(token);
        }
      }

      if (letterBuffer.length >= 2) {
        fragments.push(letterBuffer);
      }
    }

    return fragments;
  }

  _isEndChallengeRequest(norm) {
    return /\b(I GIVE UP|GIVE UP|COMPLETE|FINISH|DONE|MOVE ON|END CHALLENGE|END THIS CHALLENGE)\b/.test(norm);
  }

  async _advanceWhenReady() {
    if (!this.state.advanceIfConfirmed('ready')) return;
    this.onStatusUpdate?.(this.state.promptText);
    await this._speak(this._promptPhrase());
  }

  async _beginChallengeEnd(reason) {
    const recap = this.state.beginChallengeEnd(reason);
    if (!recap) return;

    this.onStatusUpdate?.(`Recap: ${recap.allWords.join(', ')}\nSay ready when you want the next challenge.`);

    const intro = reason === 'complete'
      ? 'Complete.'
      : 'Okay.';
    await this._speak(`${intro} ${this._recapPhrase()}`);
  }

  async _processTranscript(transcript) {
    const norm = transcript.toUpperCase().replace(/[^A-Z ]/g, '');

    if (this.state.awaitingAdvance) {
      if (this.state.isAdvanceConfirmation(norm)) {
        await this._advanceWhenReady();
      } else if (/\bREPEAT\b/.test(norm)) {
        this.onStatusUpdate?.(`Recap: ${this.state.getRecap()?.allWords.join(', ')}\nSay ready when you want the next challenge.`);
        await this._speak(this._recapPhrase());
      } else {
        this.onStatusUpdate?.('Say ready when you want the next challenge.');
        await this._speak('Say ready when you want the next challenge.');
      }
      return;
    }

    // Check voice commands first
    if (/\bHINT\b/.test(norm)) {
      await this._doHint();
      return;
    }
    if (/\bSKIP\b/.test(norm)) {
      this.state.skip();
      this.onStatusUpdate?.(`Skipped. ${this.state.promptText}`);
      await this._speak('Skipping. ' + this._promptPhrase());
      return;
    }
    if (this._isEndChallengeRequest(norm)) {
      await this._beginChallengeEnd('give_up');
      return;
    }
    if (/\bREPEAT\b/.test(norm)) {
      await this._speak(this._promptPhrase());
      return;
    }

    const fragments = this._extractFragments(norm);

    const candidates = Array.from(this.state.current.targets);
    const results = [];

    for (const frag of fragments) {
      const match = bestMatch(frag, candidates);
      if (match) {
        const status = this.state.markFound(match.word);
        if (status === 'correct') {
          results.push(`${match.word}: correct`);
        } else if (status === 'duplicate') {
          results.push(`${match.word}: already found`);
        } else {
          results.push(`${frag}: not in set`);
        }
      } else {
        results.push(`${frag}: not in set`);
      }
    }

    if (results.length === 0) {
      this.onStatusUpdate?.('No words recognized.');
      await this._speak('I didn\'t catch any words.');
      return;
    }

    const correctCount = results.filter(r => r.includes('correct')).length;
    this.onStatusUpdate?.(results.join('\n'));

    if (this.state.allFound) {
      await this._beginChallengeEnd('complete');
    } else if (correctCount > 0) {
      await this._speak(`${correctCount} correct. ${this.state.remainingCount} left.`);
    } else {
      await this._speak('Not in this set.');
    }
  }

  async _doHint() {
    if (this.state.awaitingAdvance) {
      this.onStatusUpdate?.('Say ready when you want the next challenge.');
      await this._speak('Say ready when you want the next challenge.');
      return;
    }

    const hint = this.state.advanceHint();
    if (!hint) return;

    if (hint.autoComplete) {
      const status = this.state.markFound(hint.word);
      this.onStatusUpdate?.(`${hint.word}: ${status} (hint)`);

      if (status === 'correct') {
        await this._speak(`The word is ${hint.word.split('').join(' ')}. Marking it complete.`);
      } else {
        await this._speak(`The word is ${hint.word.split('').join(' ')}.`);
      }

      if (this.state.allFound) {
        await this._beginChallengeEnd('complete');
      } else {
        await this._speak(`${this.state.remainingCount} left.`);
      }
    } else {
      this.onStatusUpdate?.(`Hint: ${hint.text}`);
      await this._speak(hint.text);
    }
  }

  async doSkip() {
    if (this.state.awaitingAdvance) {
      await this._speak('Say ready when you want the next challenge.');
      return;
    }
    this.state.skip();
    this.onStatusUpdate?.(`Skipped. ${this.state.promptText}`);
    await this._speak('Skipping. ' + this._promptPhrase());
  }
}
