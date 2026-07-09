// Tiny synth cues — no audio files. Browsers unlock AudioContext after any
// user gesture (the join click), so these are safe by session time.

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, at: number, dur: number, gainPeak = 0.12): void {
  const c = ensureCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, c.currentTime + at);
  gain.gain.linearRampToValueAtTime(gainPeak, c.currentTime + at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime + at);
  osc.stop(c.currentTime + at + dur + 0.05);
}

/** Two-tone rising ding: it's your turn. */
export function chimeYourTurn(): void {
  tone(660, 0, 0.18);
  tone(880, 0.16, 0.28);
}

/** Single soft blip: opponent event (their turn / their shot). */
export function blip(): void {
  tone(440, 0, 0.12, 0.07);
}
