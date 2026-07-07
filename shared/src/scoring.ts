// Pure scoring / match-play math. No I/O, no framework — just functions over
// data so it can be unit-tested exhaustively. This is the part that "silently
// being wrong would ruin," per the brief.

import type { Match, PlayerId } from './types.js';

/**
 * Strokes a player receives on a single hole given their course handicap and
 * that hole's stroke index (1 = hardest). Standard allocation:
 *   base  = floor(handicap / holeCount) on every hole
 *   extra = +1 on holes whose strokeIndex <= (handicap mod holeCount)
 * Negative handicaps (plus players) give strokes back symmetrically.
 */
export function strokesReceivedOnHole(
  handicap: number,
  strokeIndex: number,
  holeCount = 18,
): number {
  if (handicap === 0) return 0;
  const sign = handicap < 0 ? -1 : 1;
  const abs = Math.abs(handicap);
  const base = Math.floor(abs / holeCount);
  const remainder = abs % holeCount;
  // Positive handicaps receive extras on the hardest holes (low SI first);
  // plus handicaps give strokes back starting from the easiest (SI 18 first).
  const extra =
    sign > 0
      ? strokeIndex <= remainder
        ? 1
        : 0
      : strokeIndex > holeCount - remainder
        ? 1
        : 0;
  const total = base + extra;
  return total === 0 ? 0 : sign * total; // avoid -0
}

/** Net strokes on a hole; null gross stays null. */
export function netOnHole(
  gross: number | null,
  handicap: number,
  strokeIndex: number,
  holeCount = 18,
): number | null {
  if (gross == null) return null;
  return gross - strokesReceivedOnHole(handicap, strokeIndex, holeCount);
}

export interface StrokePlayTotals {
  grossThru: number; // holes with a gross score entered
  gross: number; // sum of entered gross
  net: number; // sum of entered net
  toParGross: number; // gross relative to par over entered holes
  toParNet: number; // net relative to par over entered holes
}

export function strokePlayTotals(match: Match, playerId: PlayerId): StrokePlayTotals {
  const scores = match.scores[playerId] ?? [];
  const player = match.players[playerId];
  const hcp = player?.handicap ?? 0;
  let gross = 0;
  let net = 0;
  let par = 0;
  let grossThru = 0;
  for (let h = 0; h < match.holeCount; h++) {
    const g = scores[h];
    if (g == null) continue;
    grossThru++;
    gross += g;
    par += match.par[h] ?? 0;
    net += g - strokesReceivedOnHole(hcp, match.strokeIndex[h] ?? 0, match.holeCount);
  }
  return {
    grossThru,
    gross,
    net,
    toParGross: gross - par,
    toParNet: net - par,
  };
}

export interface MatchPlayStatus {
  /** Player currently ahead, or null when all square. */
  leaderId: PlayerId | null;
  /** Holes up for the leader (0 when square). */
  margin: number;
  /** Number of holes both players have completed. */
  thru: number;
  /** Holes still to play after `thru`. */
  remaining: number;
  /** True once margin > remaining — the match is decided. */
  closed: boolean;
  /** "2 UP", "AS", "3 & 2", "1 UP thru 17", "DORMIE" etc. */
  text: string;
}

/**
 * Net match-play status for a 2-player match. Compares net score per hole over
 * the holes both players have completed. Returns "all square" until a hole is
 * decided. Uses conventional golf notation, including closeouts ("3 & 2") and
 * dormie.
 */
export function matchPlayStatus(match: Match, a: PlayerId, b: PlayerId): MatchPlayStatus {
  const sa = match.scores[a] ?? [];
  const sb = match.scores[b] ?? [];
  const hcpA = match.players[a]?.handicap ?? 0;
  const hcpB = match.players[b]?.handicap ?? 0;

  let up = 0; // positive => a ahead, negative => b ahead
  let thru = 0;
  // Notation captured at the hole where the match closed out, if any.
  let closeout: { margin: number; remaining: number } | null = null;

  for (let h = 0; h < match.holeCount; h++) {
    const ga = sa[h];
    const gb = sb[h];
    if (ga == null || gb == null) continue;
    thru++;
    const si = match.strokeIndex[h] ?? 0;
    const na = ga - strokesReceivedOnHole(hcpA, si, match.holeCount);
    const nb = gb - strokesReceivedOnHole(hcpB, si, match.holeCount);
    if (na < nb) up++;
    else if (nb < na) up--;

    // Holes physically left to play after this hole.
    const remainingAfter = match.holeCount - (h + 1);
    if (closeout == null && Math.abs(up) > remainingAfter) {
      closeout = { margin: Math.abs(up), remaining: remainingAfter };
    }
  }

  const remaining = match.holeCount - thru;
  const margin = Math.abs(up);
  const leaderId = up > 0 ? a : up < 0 ? b : null;
  const closed = closeout != null;

  let text: string;
  if (closeout) {
    // Conventional closeout: "3 & 2" = 3 up with 2 holes to play. If it went
    // to the final hole, it's "N UP".
    text = closeout.remaining === 0 ? `${closeout.margin} UP` : `${closeout.margin} & ${closeout.remaining}`;
  } else if (margin === 0) {
    text = thru === 0 ? 'Not started' : `AS thru ${thru}`;
  } else if (margin === remaining && remaining > 0) {
    text = `DORMIE (${margin} UP thru ${thru})`;
  } else {
    text = `${margin} UP thru ${thru}`;
  }

  return { leaderId, margin, thru, remaining, closed, text };
}
