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

/** Snapshot the region from a playing <video>, upscaled 2x for small text. */
function snapshotRegion(video: HTMLVideoElement, region: Region): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sx = region.x * vw;
  const sy = region.y * vh;
  const sw = region.w * vw;
  const sh = region.h * vh;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * 2));
  canvas.height = Math.max(1, Math.round(sh * 2));
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingEnabled = false;
  g.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
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
