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

  get allFound() {
    return this.remainingCount <= 0;
  }

  markFound(word) {
    if (!this.current) return 'invalid';
    const norm = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (!this.current.targets.has(norm)) return 'invalid';
    if (this.current.found.has(norm)) return 'duplicate';
    this.current.found.add(norm);
    return 'correct';
  }

  advanceHint() {
    if (!this.current) return null;
    this.current.hintLevel += 1;
    const remaining = Array.from(this.current.targets)
      .filter(w => !this.current.found.has(w))
      .sort();
    const n = remaining.length;
    if (n <= 0) return { level: 0, text: 'You already have them all.' };

    const target = remaining[0];
    const level = this.current.hintLevel;

    if (level === 1) {
      return { level, text: `${n} remaining.` };
    } else if (level === 2) {
      return { level, text: `One starts with ${target.slice(0, 2)}.` };
    } else if (level === 3) {
      const letters = target.split('');
      if (letters.length >= 5) {
        letters[2] = '_';
        letters[letters.length - 3] = '_';
      } else if (letters.length >= 3) {
        letters[1] = '_';
      }
      return { level, text: letters.join(' ') };
    } else {
      // Full reveal, reset hint level
      this.current.hintLevel = 0;
      return { level: 4, text: target };
    }
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
      const found = Array.from(this.current.found).sort();
      if (found.length) {
        lines.push(`- Already found: ${found.join(', ')}`);
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
