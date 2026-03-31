const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // ~100ms at 16kHz

const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._buffer = [];
    this._targetRate = options.processorOptions.targetRate || 16000;
    this._needsResample = Math.abs(sampleRate - this._targetRate) > 1;
    this._resampleRatio = this._needsResample ? this._targetRate / sampleRate : 1;
    this._resampleAccum = 0;
    this._chunkSize = options.processorOptions.chunkSize || 1600;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    if (this._needsResample) {
      for (let i = 0; i < input.length; i++) {
        this._resampleAccum += this._resampleRatio;
        if (this._resampleAccum >= 1) {
          this._resampleAccum -= 1;
          this._buffer.push(Math.max(-32768, Math.min(32767, (input[i] * 32767) | 0)));
        }
      }
    } else {
      for (let i = 0; i < input.length; i++) {
        this._buffer.push(Math.max(-32768, Math.min(32767, (input[i] * 32767) | 0)));
      }
    }

    while (this._buffer.length >= this._chunkSize) {
      const chunk = new Int16Array(this._buffer.splice(0, this._chunkSize));
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

function int16ToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class AudioCapture {
  constructor() {
    this.onChunk = null;
    this._ctx = null;
    this._stream = null;
    this._source = null;
    this._workletNode = null;
    this._scriptNode = null;
  }

  async start() {
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Try to create context at target rate; iOS may ignore this
    this._ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
    const actualRate = this._ctx.sampleRate;

    this._source = this._ctx.createMediaStreamSource(this._stream);

    try {
      await this._setupWorklet(actualRate);
    } catch {
      this._setupScriptProcessor(actualRate);
    }

    // iOS requires resume inside a user gesture -- caller should ensure this
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }
  }

  async _setupWorklet(actualRate) {
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this._ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this._workletNode = new AudioWorkletNode(this._ctx, 'pcm-processor', {
      processorOptions: {
        targetRate: TARGET_RATE,
        chunkSize: CHUNK_SAMPLES,
      },
    });

    this._workletNode.port.onmessage = (e) => {
      if (this.onChunk) {
        this.onChunk(int16ToBase64(e.data));
      }
    };

    this._source.connect(this._workletNode);
    this._workletNode.connect(this._ctx.destination); // required for processing to run
  }

  _setupScriptProcessor(actualRate) {
    const bufferSize = 4096;
    this._scriptNode = this._ctx.createScriptProcessor(bufferSize, 1, 1);

    const needsResample = Math.abs(actualRate - TARGET_RATE) > 1;
    const ratio = needsResample ? TARGET_RATE / actualRate : 1;
    let accumBuffer = [];
    let resampleAccum = 0;

    this._scriptNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);

      if (needsResample) {
        for (let i = 0; i < input.length; i++) {
          resampleAccum += ratio;
          if (resampleAccum >= 1) {
            resampleAccum -= 1;
            accumBuffer.push(Math.max(-32768, Math.min(32767, (input[i] * 32767) | 0)));
          }
        }
      } else {
        for (let i = 0; i < input.length; i++) {
          accumBuffer.push(Math.max(-32768, Math.min(32767, (input[i] * 32767) | 0)));
        }
      }

      while (accumBuffer.length >= CHUNK_SAMPLES) {
        const chunk = new Int16Array(accumBuffer.splice(0, CHUNK_SAMPLES));
        if (this.onChunk) {
          this.onChunk(int16ToBase64(chunk.buffer));
        }
      }
    };

    this._source.connect(this._scriptNode);
    this._scriptNode.connect(this._ctx.destination);
  }

  stop() {
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._scriptNode) {
      this._scriptNode.disconnect();
      this._scriptNode = null;
    }
    if (this._source) {
      this._source.disconnect();
      this._source = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
    }
  }
}
