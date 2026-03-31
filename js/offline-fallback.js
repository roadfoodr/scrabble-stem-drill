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
    await this._speak('Offline mode. ' + this._promptPhrase());
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

  async _processTranscript(transcript) {
    const norm = transcript.toUpperCase().replace(/[^A-Z ]/g, '');

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
    if (/\bREPEAT\b/.test(norm)) {
      await this._speak(this._promptPhrase());
      return;
    }

    // Split into candidate words on spaces, commas, "and"
    const fragments = norm.split(/\s+AND\s+|\s+/)
      .map(f => f.replace(/[^A-Z]/g, ''))
      .filter(f => f.length >= 4);

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
      await this._speak(`Complete! You got all ${this.state.current.targets.size}.`);
      this.state.next();
      this.onStatusUpdate?.(this.state.promptText);
      await this._speak(this._promptPhrase());
    } else if (correctCount > 0) {
      await this._speak(`${correctCount} correct. ${this.state.remainingCount} left.`);
    } else {
      await this._speak('Not in this set.');
    }
  }

  async _doHint() {
    const hint = this.state.advanceHint();
    if (!hint) return;
    this.onStatusUpdate?.(`Hint: ${hint.text}`);
    if (hint.level === 4) {
      // Spell it out on reveal
      await this._speak(`The word is ${hint.text.split('').join(' ')}.`);
    } else {
      await this._speak(hint.text);
    }
  }
}
