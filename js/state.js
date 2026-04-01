import { DATA } from './data.js';

export class DrillState {
  constructor() {
    this.queue = [];
    this.idx = 0;
    this.current = null;
  }

  buildQueue() {
    const items = [];
    for (const stem of Object.keys(DATA)) {
      for (const letter of Object.keys(DATA[stem]).sort()) {
        items.push({ stem, letter });
      }
    }
    // Fisher-Yates shuffle
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    this.queue = items;
  }

  loadPrompt(index) {
    if (!this.queue.length) this.buildQueue();
    this.idx = ((index % this.queue.length) + this.queue.length) % this.queue.length;
    const { stem, letter } = this.queue[this.idx];
    const words = DATA[stem][letter] || [];
    this.current = {
      stem,
      letter,
      targets: new Set(words),
      found: new Set(),
      hintLevel: 0,
      pendingAdvanceReason: null,
    };
  }

  get promptText() {
    return this.current ? `${this.current.stem} + ${this.current.letter}` : '';
  }

  get remainingCount() {
    return this.current ? this.current.targets.size - this.current.found.size : 0;
  }

  get foundCount() {
    return this.current ? this.current.found.size : 0;
  }

  get allWords() {
    return this.current ? Array.from(this.current.targets).sort() : [];
  }

  get foundWords() {
    return this.current ? Array.from(this.current.found).sort() : [];
  }

  get remainingWords() {
    return this.current
      ? Array.from(this.current.targets).filter(w => !this.current.found.has(w)).sort()
      : [];
  }

  get awaitingAdvance() {
    return !!this.current?.pendingAdvanceReason;
  }

  get allFound() {
    return this.remainingCount <= 0;
  }

  resetHintLevel() {
    if (this.current) {
      this.current.hintLevel = 0;
    }
  }

  markFound(word) {
    if (!this.current) return 'invalid';
    const norm = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (!this.current.targets.has(norm)) return 'invalid';
    if (this.current.found.has(norm)) return 'duplicate';
    this.current.found.add(norm);
    this.resetHintLevel();
    return 'correct';
  }

  advanceHint() {
    if (!this.current) return null;
    this.current.hintLevel += 1;
    const remaining = this.remainingWords;
    if (remaining.length <= 0) return { level: 0, text: 'You already have them all.' };

    const target = remaining[0];
    const level = this.current.hintLevel;

    if (level === 1) {
      return { level, text: `One starts with ${target.slice(0, 2)}.`, word: target };
    } else if (level === 2) {
      return { level, text: this._buildPattern(target), word: target };
    } else {
      this.resetHintLevel();
      return { level: 3, text: target, word: target, autoComplete: true };
    }
  }

  _buildPattern(target) {
    const letters = target.split('');
    if (letters.length >= 5) {
      letters[2] = '_';
      letters[letters.length - 3] = '_';
    } else if (letters.length >= 3) {
      letters[1] = '_';
    }
    return letters.join(' ');
  }

  beginChallengeEnd(reason = 'complete') {
    if (!this.current) return null;
    this.current.pendingAdvanceReason = reason || 'complete';
    return this.getRecap();
  }

  clearChallengeEnd() {
    if (this.current) {
      this.current.pendingAdvanceReason = null;
    }
  }

  getRecap(reason = null) {
    if (!this.current) return null;
    return {
      stem: this.current.stem,
      letter: this.current.letter,
      reason: reason || this.current.pendingAdvanceReason || 'complete',
      allWords: this.allWords,
      foundWords: this.foundWords,
      remainingWords: this.remainingWords,
    };
  }

  isAdvanceConfirmation(text) {
    const norm = String(text || '')
      .toUpperCase()
      .replace(/[^A-Z ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!norm) return false;
    if (/\b(NOT READY|NOT YET|WAIT|HOLD ON|STOP)\b/.test(norm)) return false;
    return /\b(READY|CONTINUE|NEXT|YES|YEAH|YEP|OK|OKAY|ALRIGHT|SURE|GO|PROCEED|MOVE ON|KEEP GOING|LETS GO|LET S GO|GO AHEAD)\b/.test(norm);
  }

  advanceIfConfirmed(text) {
    if (!this.awaitingAdvance) return false;
    if (text && !this.isAdvanceConfirmation(text)) return false;
    this.next();
    return true;
  }

  next() {
    this.loadPrompt(this.idx + 1);
  }

  skip() {
    this.next();
  }

  serialize() {
    return {
      queue: this.queue,
      idx: this.idx,
      current: this.current ? {
        stem: this.current.stem,
        letter: this.current.letter,
        found: Array.from(this.current.found),
        hintLevel: this.current.hintLevel,
        pendingAdvanceReason: this.current.pendingAdvanceReason,
      } : null,
    };
  }

  restore(snapshot) {
    this.queue = snapshot.queue;
    this.idx = snapshot.idx;
    if (snapshot.current) {
      const { stem, letter } = snapshot.current;
      const words = DATA[stem][letter] || [];
      this.current = {
        stem,
        letter,
        targets: new Set(words),
        found: new Set(snapshot.current.found),
        hintLevel: snapshot.current.hintLevel,
        pendingAdvanceReason: snapshot.current.pendingAdvanceReason || null,
      };
    }
  }

  toPromptContext() {
    const lines = [];
    lines.push('DRILL QUEUE (present in this order):');
    this.queue.forEach((item, i) => {
      const words = DATA[item.stem][item.letter] || [];
      lines.push(`${i + 1}. ${item.stem} + ${item.letter} -> ${words.join(', ')}`);
    });
    lines.push('');
    if (this.current) {
      lines.push('CURRENT STATE:');
      lines.push(`- Currently on item ${this.idx + 1}: ${this.current.stem} + ${this.current.letter}`);
      const found = this.foundWords;
      if (found.length) {
        lines.push(`- Already found: ${found.join(', ')}`);
      }
      if (this.awaitingAdvance) {
        lines.push(`- Challenge ending reason: ${this.current.pendingAdvanceReason}`);
        lines.push('- Waiting for the user to say they are ready for the next challenge.');
      }
      lines.push(`- ${this.remainingCount} of ${this.current.targets.size} remaining`);
      lines.push(`- Hint level: ${this.current.hintLevel}`);
      lines.push('- Resume from this prompt.');
    } else {
      lines.push('CURRENT STATE:');
      lines.push('- Begin with item 1.');
    }
    return lines.join('\n');
  }
}
