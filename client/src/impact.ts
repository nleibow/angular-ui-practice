// Club-impact detector. A golf strike is a sharp broadband transient: near
// silence -> big spike -> gone within ~50ms. Speech ramps up and sustains, so
// we gate on three things:
//   1. the room was reasonably quiet just before the spike,
//   2. the spike is far above the rolling noise floor,
//   3. a refractory period so one shot can't double-fire.
// It runs on the same mic stream used for voice chat — zero extra setup.

export type Sensitivity = 'off' | 'low' | 'high';

interface Thresholds {
  /** Spike must exceed noiseFloor * ratio. */
  ratio: number;
  /** Absolute RMS floor so a dead-quiet room doesn't fire on tiny noises. */
  minRms: number;
}

const TUNING: Record<Exclude<Sensitivity, 'off'>, Thresholds> = {
  low: { ratio: 8, minRms: 0.09 }, // needs a real crack
  high: { ratio: 5, minRms: 0.05 }, // picks up softer strikes (wedges, mats)
};

const REFRACTORY_MS = 4000; // one shot, one event — ball flight lasts longer
const QUIET_WINDOW_MS = 350; // how long it must be calm before the spike

export class ImpactDetector {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private raf = 0;
  private buf: Float32Array<ArrayBuffer> = new Float32Array(0);
  private noiseFloor = 0.01;
  private lastLoudAt = 0;
  private lastFireAt = 0;
  sensitivity: Sensitivity = 'high';

  constructor(private onImpact: () => void) {}

  start(stream: MediaStream): void {
    this.stop();
    try {
      this.ctx = new AudioContext();
      void this.ctx.resume();
      this.source = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.source.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);
      this.loop();
    } catch (err) {
      console.warn('impact detector unavailable', err);
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.source?.disconnect();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.source = null;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const analyser = this.analyser;
    if (!analyser || this.sensitivity === 'off') return;

    analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / this.buf.length);
    const now = performance.now();
    const t = TUNING[this.sensitivity];

    const isSpike =
      rms > t.minRms &&
      rms > this.noiseFloor * t.ratio &&
      peak > rms * 1.8 && // transient crest, not a sustained tone
      now - this.lastLoudAt > QUIET_WINDOW_MS &&
      now - this.lastFireAt > REFRACTORY_MS;

    if (isSpike) {
      this.lastFireAt = now;
      this.onImpact();
    }

    // Track "the room is loud" (speech/music) to enforce the quiet window.
    if (rms > Math.max(this.noiseFloor * 2.5, 0.02) && !isSpike) {
      this.lastLoudAt = now;
    }

    // Slow exponential noise-floor tracker (ignores the spike itself).
    if (!isSpike) this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
  };
}
