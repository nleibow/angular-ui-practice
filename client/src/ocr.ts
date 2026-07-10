// Screen-region OCR for sim stats. The player draws one box over where their
// sim displays shot numbers (carry / ball speed / etc.). After each detected
// shot we snapshot that region from the local share, run tesseract (fully
// self-hosted under /ocr — no CDN), and parse label+number pairs.

import type { Worker } from 'tesseract.js';

export interface Region {
  // Normalized 0..1 within the *video frame* (not the letterboxed pane).
  x: number;
  y: number;
  w: number;
  h: number;
}

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { createWorker, PSM } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, {
      workerPath: '/ocr/worker.min.js',
      corePath: '/ocr',
      langPath: '/ocr/tessdata',
      gzip: true,
    });
    // Sim overlays are scattered short labels/numbers, not paragraphs.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    return worker;
  })();
  return workerPromise;
}

/** Warm the OCR engine in the background so the first shot isn't slow. */
export function preloadOcr(): void {
  void getWorker().catch(() => (workerPromise = null));
}

/**
 * The <video> letterboxes the frame (object-fit: contain), so a rectangle
 * drawn in pane pixels must be mapped into video-frame coordinates.
 */
export function paneRectToRegion(
  pane: { width: number; height: number },
  video: { videoWidth: number; videoHeight: number },
  rect: { x: number; y: number; w: number; h: number },
): Region | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(pane.width / video.videoWidth, pane.height / video.videoHeight);
  const dispW = video.videoWidth * scale;
  const dispH = video.videoHeight * scale;
  const offX = (pane.width - dispW) / 2;
  const offY = (pane.height - dispH) / 2;
  const x = (rect.x - offX) / dispW;
  const y = (rect.y - offY) / dispH;
  const w = rect.w / dispW;
  const h = rect.h / dispH;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const cx = clamp(x);
  const cy = clamp(y);
  const region = { x: cx, y: cy, w: clamp(x + w) - cx, h: clamp(y + h) - cy };
  return region.w < 0.01 || region.h < 0.01 ? null : region;
}

/** Inverse of paneRectToRegion — for drawing the saved box over the preview. */
export function regionToPaneRect(
  pane: { width: number; height: number },
  video: { videoWidth: number; videoHeight: number },
  region: Region,
): { x: number; y: number; w: number; h: number } | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(pane.width / video.videoWidth, pane.height / video.videoHeight);
  const dispW = video.videoWidth * scale;
  const dispH = video.videoHeight * scale;
  const offX = (pane.width - dispW) / 2;
  const offY = (pane.height - dispH) / 2;
  return {
    x: offX + region.x * dispW,
    y: offY + region.y * dispH,
    w: region.w * dispW,
    h: region.h * dispH,
  };
}

/**
 * Snapshot the region from a playing <video>, upscaled and preprocessed for
 * OCR. Sim overlays are typically small light text on a dark widget, which
 * raw tesseract reads poorly, so we: upscale until text is ~legible size,
 * grayscale, invert when the region is dark (tesseract wants dark-on-light),
 * and stretch contrast.
 */
function snapshotRegion(video: HTMLVideoElement, region: Region): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sx = region.x * vw;
  const sy = region.y * vh;
  const sw = Math.max(1, region.w * vw);
  const sh = Math.max(1, region.h * vh);
  // Upscale so the region is at least ~200px tall (helps small widget text),
  // capped to keep recognition fast.
  const scale = Math.min(6, Math.max(2, Math.ceil(200 / sh)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  // Grayscale + brightness census.
  let sum = 0;
  const grays = new Uint8ClampedArray(d.length / 4);
  for (let i = 0; i < grays.length; i++) {
    const o = i * 4;
    const v = (d[o] * 3 + d[o + 1] * 4 + d[o + 2]) >> 3;
    grays[i] = v;
    sum += v;
  }
  const mean = sum / grays.length;
  const invert = mean < 128; // dark widget => light text; flip to dark-on-light
  // Contrast stretch around the 5th/95th percentile.
  const hist = new Array(256).fill(0);
  for (let i = 0; i < grays.length; i++) hist[grays[i]]++;
  let lo = 0;
  let hi = 255;
  let acc = 0;
  const n = grays.length;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * 0.05) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= n * 0.05) {
      hi = v;
      break;
    }
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < grays.length; i++) {
    let v = ((grays[i] - lo) / range) * 255;
    v = Math.max(0, Math.min(255, v));
    if (invert) v = 255 - v;
    const o = i * 4;
    d[o] = d[o + 1] = d[o + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

export async function readRegionText(video: HTMLVideoElement, region: Region): Promise<string> {
  const canvas = snapshotRegion(video, region);
  if (!canvas) return '';
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  return data.text ?? '';
}

// --- stat parsing -------------------------------------------------------------

const LABELS: Array<[RegExp, string]> = [
  [/carry/i, 'Carry'],
  [/total/i, 'Total'],
  [/ball\s*speed|ball/i, 'Ball speed'],
  [/club\s*head|club/i, 'Club speed'],
  [/back\s*spin|spin/i, 'Spin'],
  [/launch/i, 'Launch'],
  [/apex|height/i, 'Apex'],
  [/side|offline|deviation/i, 'Side'],
  [/smash/i, 'Smash'],
];

const NUM = /(-?\d+(?:[.,]\d+)?)\s*(mph|km\/h|yds?|yards?|m\b|ft|rpm|°|deg)?/i;

/**
 * Turn raw OCR text into display stats. Prefers "label + number" lines; falls
 * back to bare numbers so a mis-set box still produces something inspectable.
 */
export function parseSimStats(text: string): Record<string, string> {
  const stats: Record<string, string> = {};
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const label = LABELS.find(([re]) => re.test(line))?.[1];
    if (!label || stats[label]) continue;
    const m = line.match(NUM);
    if (m && m[1]) stats[label] = m[2] ? `${m[1]} ${m[2]}` : m[1];
  }

  if (Object.keys(stats).length === 0) {
    // Bare-number fallback: grab up to 3 standalone readings ≥ 2 digits.
    const all = [...text.matchAll(/-?\d{2,4}(?:[.,]\d+)?/g)].slice(0, 3);
    all.forEach((m, i) => (stats[`Reading ${i + 1}`] = m[0]));
  }
  return stats;
}
