const OUTPUT_RATE = 24000;

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function int16ToFloat32(int16) {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

export class AudioPlayback {
  constructor() {
    this._ctx = null;
    this._nextPlayTime = 0;
    this._activeNodes = [];
  }

  _ensureContext() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUTPUT_RATE });
    }
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }
  }

  enqueue(base64Pcm) {
    this._ensureContext();

    const samples = int16ToFloat32(base64ToInt16(base64Pcm));
    if (samples.length === 0) return;

    const buffer = this._ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.getChannelData(0).set(samples);

    const source = this._ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this._ctx.destination);

    const startTime = Math.max(this._ctx.currentTime, this._nextPlayTime);
    source.start(startTime);
    this._nextPlayTime = startTime + buffer.duration;

    this._activeNodes.push(source);
    source.onended = () => {
      const idx = this._activeNodes.indexOf(source);
      if (idx !== -1) this._activeNodes.splice(idx, 1);
    };
  }

  flush() {
    for (const node of this._activeNodes) {
      try { node.stop(); } catch {}
    }
    this._activeNodes = [];
    this._nextPlayTime = 0;
  }

  get isPlaying() {
    return this._activeNodes.length > 0;
  }

  close() {
    this.flush();
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
    }
  }
}
