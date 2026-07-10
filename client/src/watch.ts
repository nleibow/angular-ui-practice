// Screen-based shot detection. The player draws a "watch box" over the part of
// their sim that changes when a shot is recorded (in Home Tee Hero: the
// scorecard widget top-left — the shot-number highlight advances after every
// swing). We poll that region and fire when its pixels change and then settle.
// Far more reliable than audio: no false positives from talking, no echo.

export type WatchTrigger = () => void;

const POLL_MS = 700;
const SAMPLE = 64; // region downscaled to SAMPLE x SAMPLE grayscale for diffing
// A shot updates a small but *strong* cluster of pixels (a digit flips from
// dim to bright). Video-compression noise is weak and diffuse. So we count
// pixels whose gray value moved a lot, not the average movement.
const PIXEL_DELTA = 26; // per-pixel gray delta that counts as "really changed"
const TRIGGER_FRACTION = 0.004; // ≥0.4% of sampled pixels strongly changed
const SETTLE_MS = 1000; // change must stop for this long before we fire
const REFRACTORY_MS = 5000; // min gap between fired shots

export interface WatchRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class ScreenWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private canvas = document.createElement('canvas');
  private prev: Uint8ClampedArray | null = null;
  private changedAt = 0;
  private pendingFire = false;
  // -Infinity so the refractory window never blocks the first shot.
  private lastFireAt = -Infinity;
  // Debug counters (read via window.__rm.debug()).
  tickCount = 0;
  fireCount = 0;
  lastFraction = 0;
  maxFraction = 0;

  constructor(private onShot: WatchTrigger) {
    this.canvas.width = SAMPLE;
    this.canvas.height = SAMPLE;
  }

  start(video: HTMLVideoElement, region: WatchRegion): void {
    this.stop();
    this.prev = null;
    this.pendingFire = false;
    this.timer = setInterval(() => this.tick(video, region), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.prev = null;
    this.pendingFire = false;
  }

  get running(): boolean {
    return this.timer != null;
  }

  private tick(video: HTMLVideoElement, region: WatchRegion): void {
    this.tickCount++;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const g = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return;

    g.drawImage(
      video,
      region.x * vw,
      region.y * vh,
      Math.max(1, region.w * vw),
      Math.max(1, region.h * vh),
      0,
      0,
      SAMPLE,
      SAMPLE,
    );
    const data = g.getImageData(0, 0, SAMPLE, SAMPLE).data;
    const gray = new Uint8ClampedArray(SAMPLE * SAMPLE);
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4;
      gray[i] = (data[o] * 3 + data[o + 1] * 4 + data[o + 2]) >> 3;
    }

    if (this.prev) {
      let changed = 0;
      for (let i = 0; i < gray.length; i++) {
        if (Math.abs(gray[i] - this.prev[i]) > PIXEL_DELTA) changed++;
      }
      const changedFraction = changed / gray.length;
      this.lastFraction = changedFraction;
      if (changedFraction > this.maxFraction) this.maxFraction = changedFraction;
      const now = performance.now();

      if (changedFraction > TRIGGER_FRACTION) {
        // The widget is repainting (shot registered / hole changed).
        this.changedAt = now;
        if (now - this.lastFireAt > REFRACTORY_MS) this.pendingFire = true;
      } else if (this.pendingFire && now - this.changedAt > SETTLE_MS) {
        // It changed and has now settled — that was a shot.
        this.pendingFire = false;
        this.lastFireAt = now;
        this.fireCount++;
        this.onShot();
      }
    }
    this.prev = gray;
  }
}
