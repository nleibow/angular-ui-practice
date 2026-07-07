// Match construction + the pure reducer that applies a client patch. Kept here
// (not in the server) so state transitions are unit-testable and identical
// wherever they run.

import type { Match, MatchPatch, Player, PlayerId } from './types.js';

// A standard 18-hole, par-72 men's layout with a typical stroke-index spread
// (odds on the front nine, evens on the back — a common allocation).
export const DEFAULT_PAR_18 = [4, 4, 5, 3, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
export const DEFAULT_SI_18 = [7, 3, 11, 15, 1, 9, 17, 5, 13, 8, 4, 12, 16, 2, 10, 18, 6, 14];

export function createMatch(id: string, holeCount: 9 | 18 = 18): Match {
  const par = DEFAULT_PAR_18.slice(0, holeCount);
  const strokeIndex = normalizeStrokeIndex(DEFAULT_SI_18.slice(0, holeCount));
  return {
    id,
    createdAt: Date.now(),
    holeCount,
    par,
    strokeIndex,
    players: {},
    order: [],
    scores: {},
    hittingPlayerId: null,
    version: 0,
  };
}

/** When truncating to 9 holes the sliced stroke indexes aren't 1..9; re-rank. */
function normalizeStrokeIndex(si: number[]): number[] {
  const sorted = [...si].map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
  const rank = new Array(si.length);
  sorted.forEach((entry, idx) => (rank[entry.i] = idx + 1));
  return rank;
}

export function addPlayer(match: Match, player: Player): void {
  match.players[player.id] = player;
  if (!match.order.includes(player.id)) match.order.push(player.id);
  if (!match.scores[player.id]) {
    match.scores[player.id] = new Array(match.holeCount).fill(null);
  }
}

/**
 * Apply a patch in place and return whether anything changed. The server bumps
 * `version` and persists when this returns true. Pure w.r.t. external state.
 */
export function applyPatch(match: Match, patch: MatchPatch): boolean {
  let changed = false;

  if (patch.setScore) {
    const { playerId, hole, strokes } = patch.setScore;
    const row = match.scores[playerId];
    if (row && hole >= 0 && hole < match.holeCount) {
      const clean = strokes == null ? null : clampStrokes(strokes);
      if (row[hole] !== clean) {
        row[hole] = clean;
        changed = true;
      }
    }
  }

  if (patch.setHandicap) {
    const { playerId, handicap } = patch.setHandicap;
    const p = match.players[playerId];
    const clean = clampHandicap(handicap);
    if (p && p.handicap !== clean) {
      p.handicap = clean;
      changed = true;
    }
  }

  if (patch.setHitting) {
    const target = patch.setHitting.playerId;
    if (target === null || match.players[target]) {
      if (match.hittingPlayerId !== target) {
        match.hittingPlayerId = target;
        changed = true;
      }
    }
  }

  if (patch.setHoleCount) {
    const hc = patch.setHoleCount.holeCount === 9 ? 9 : 18;
    if (hc !== match.holeCount) {
      resizeHoles(match, hc);
      changed = true;
    }
  }

  return changed;
}

function clampStrokes(n: number): number {
  return Math.max(1, Math.min(20, Math.round(n)));
}

function clampHandicap(n: number): number {
  return Math.max(-10, Math.min(54, Math.round(n)));
}

function resizeHoles(match: Match, holeCount: 9 | 18): void {
  match.holeCount = holeCount;
  match.par = DEFAULT_PAR_18.slice(0, holeCount);
  match.strokeIndex = normalizeStrokeIndex(DEFAULT_SI_18.slice(0, holeCount));
  for (const pid of Object.keys(match.scores) as PlayerId[]) {
    const old = match.scores[pid];
    const next = new Array(holeCount).fill(null);
    for (let i = 0; i < holeCount; i++) next[i] = old[i] ?? null;
    match.scores[pid] = next;
  }
}
