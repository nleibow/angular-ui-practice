import { describe, it, expect } from 'vitest';
import {
  strokesReceivedOnHole,
  netOnHole,
  strokePlayTotals,
  matchPlayStatus,
} from './scoring.js';
import { createMatch, addPlayer, applyPatch } from './match.js';
import type { Match, PlayerId } from './types.js';

// --- helpers ----------------------------------------------------------------

function twoPlayerMatch(hcpA = 0, hcpB = 0, holeCount: 9 | 18 = 18): Match {
  const m = createMatch('t', holeCount);
  addPlayer(m, { id: 'A', name: 'Nate', handicap: hcpA, connected: true });
  addPlayer(m, { id: 'B', name: 'Buddy', handicap: hcpB, connected: true });
  return m;
}

/** Fill holes [0..n) with the given per-player gross scores. */
function setScores(m: Match, pid: PlayerId, grosses: (number | null)[]): void {
  grosses.forEach((g, hole) => applyPatch(m, { setScore: { playerId: pid, hole, strokes: g } }));
}

// --- strokesReceivedOnHole --------------------------------------------------

describe('strokesReceivedOnHole', () => {
  it('scratch player gets nothing', () => {
    expect(strokesReceivedOnHole(0, 1)).toBe(0);
    expect(strokesReceivedOnHole(0, 18)).toBe(0);
  });

  it('a 16 handicap gets one stroke on the 16 hardest holes, none on SI 17/18', () => {
    for (let si = 1; si <= 16; si++) expect(strokesReceivedOnHole(16, si)).toBe(1);
    expect(strokesReceivedOnHole(16, 17)).toBe(0);
    expect(strokesReceivedOnHole(16, 18)).toBe(0);
  });

  it('a full 18 gives one stroke on every hole', () => {
    for (let si = 1; si <= 18; si++) expect(strokesReceivedOnHole(18, si)).toBe(1);
  });

  it('handicaps over 18 double up on the hardest holes', () => {
    // 22 => base 1 everywhere, +1 on SI 1..4
    expect(strokesReceivedOnHole(22, 1)).toBe(2);
    expect(strokesReceivedOnHole(22, 4)).toBe(2);
    expect(strokesReceivedOnHole(22, 5)).toBe(1);
    expect(strokesReceivedOnHole(22, 18)).toBe(1);
  });

  it('plus handicaps give strokes back on the easiest holes', () => {
    // +2 => gives a stroke back on the two easiest holes (SI 17, 18)
    expect(strokesReceivedOnHole(-2, 18)).toBe(-1);
    expect(strokesReceivedOnHole(-2, 17)).toBe(-1);
    expect(strokesReceivedOnHole(-2, 16)).toBe(0);
    expect(strokesReceivedOnHole(-2, 1)).toBe(0);
  });

  it('total strokes received equals the handicap', () => {
    for (const hcp of [5, 16, 18, 27, 36]) {
      let total = 0;
      for (let si = 1; si <= 18; si++) total += strokesReceivedOnHole(hcp, si);
      expect(total).toBe(hcp);
    }
  });

  it('netOnHole subtracts received strokes and preserves null', () => {
    expect(netOnHole(5, 16, 1)).toBe(4);
    expect(netOnHole(5, 16, 18)).toBe(5);
    expect(netOnHole(null, 16, 1)).toBeNull();
  });
});

// --- stroke play ------------------------------------------------------------

describe('strokePlayTotals', () => {
  it('sums gross and net over entered holes only', () => {
    const m = twoPlayerMatch(16, 0);
    // A plays 3 holes: par 4,4,5 with SI 7,3,11 -> all get a stroke (<=16)
    setScores(m, 'A', [6, 5, 7]);
    const t = strokePlayTotals(m, 'A');
    expect(t.grossThru).toBe(3);
    expect(t.gross).toBe(18);
    expect(t.net).toBe(15); // 18 - 3 received strokes
    expect(t.toParGross).toBe(18 - (4 + 4 + 5)); // +5
    expect(t.toParNet).toBe(15 - 13); // +2
  });

  it('ignores unentered holes', () => {
    const m = twoPlayerMatch(0, 0);
    setScores(m, 'A', [4, null, 5]);
    const t = strokePlayTotals(m, 'A');
    expect(t.grossThru).toBe(2);
    expect(t.gross).toBe(9);
  });
});

// --- match play -------------------------------------------------------------

describe('matchPlayStatus', () => {
  it('is Not started with no scores', () => {
    const m = twoPlayerMatch();
    const s = matchPlayStatus(m, 'A', 'B');
    expect(s.text).toBe('Not started');
    expect(s.leaderId).toBeNull();
    expect(s.thru).toBe(0);
  });

  it('reports all square when holes are halved', () => {
    const m = twoPlayerMatch();
    setScores(m, 'A', [4, 4, 4]);
    setScores(m, 'B', [4, 4, 4]);
    const s = matchPlayStatus(m, 'A', 'B');
    expect(s.margin).toBe(0);
    expect(s.text).toBe('AS thru 3');
  });

  it('counts holes up for the leader', () => {
    const m = twoPlayerMatch();
    // A wins holes 1 and 3, halves 2 => 2 UP thru 3
    setScores(m, 'A', [3, 4, 3]);
    setScores(m, 'B', [4, 4, 4]);
    const s = matchPlayStatus(m, 'A', 'B');
    expect(s.leaderId).toBe('A');
    expect(s.margin).toBe(2);
    expect(s.text).toBe('2 UP thru 3');
  });

  it('only counts holes both players have completed', () => {
    const m = twoPlayerMatch();
    setScores(m, 'A', [3, 4, 3, 4]);
    setScores(m, 'B', [4, 4, 4]); // hole 4 missing for B
    const s = matchPlayStatus(m, 'A', 'B');
    expect(s.thru).toBe(3);
  });

  it('applies net strokes when handicaps differ', () => {
    // A gross 5, B gross 4 on hole SI 1; A is a 18 so gets a stroke -> net 4 vs 4 => halve
    const m = twoPlayerMatch(18, 0);
    // hole index 4 has SI 1 in the default layout
    applyPatch(m, { setScore: { playerId: 'A', hole: 4, strokes: 5 } });
    applyPatch(m, { setScore: { playerId: 'B', hole: 4, strokes: 4 } });
    const s = matchPlayStatus(m, 'A', 'B');
    expect(s.margin).toBe(0); // halved on net
    expect(s.text).toBe('AS thru 1');
  });

  it('closes out with conventional "3 & 2" notation', () => {
    const m = twoPlayerMatch();
    // A wins the first 3 holes, then holes 4..16 are halved => 3 up thru 16,
    // 2 to play => closed 3 & 2. (net = gross, both scratch.)
    const a: number[] = [];
    const b: number[] = [];
    for (let h = 0; h < 16; h++) {
      if (h < 3) {
        a.push(3);
        b.push(4);
      } else {
        a.push(4);
        b.push(4);
      }
    }
    setScores(m, 'A', a);
    setScores(m, 'B', b);
    const s = matchPlayStatus(m, 'A', 'B');
    expect(s.closed).toBe(true);
    expect(s.margin).toBe(3);
    expect(s.text).toBe('3 & 2');
  });

  it('reports dormie when the lead equals the holes remaining', () => {
    const m = twoPlayerMatch();
    const a: number[] = [];
    const b: number[] = [];
    // A up 2 thru 16 => 2 remaining => dormie
    for (let h = 0; h < 16; h++) {
      if (h < 2) {
        a.push(3);
        b.push(4);
      } else {
        a.push(4);
        b.push(4);
      }
    }
    setScores(m, 'A', a);
    setScores(m, 'B', b);
    const s = matchPlayStatus(m, 'A', 'B');
    expect(s.closed).toBe(false);
    expect(s.text).toContain('DORMIE');
  });

  it('a one-hole lead standing to 18 is "1 UP"', () => {
    const m = twoPlayerMatch();
    const a: number[] = [];
    const b: number[] = [];
    for (let h = 0; h < 18; h++) {
      if (h === 0) {
        a.push(3);
        b.push(4);
      } else {
        a.push(4);
        b.push(4);
      }
    }
    setScores(m, 'A', a);
    setScores(m, 'B', b);
    const s = matchPlayStatus(m, 'A', 'B');
    expect(s.margin).toBe(1);
    expect(s.remaining).toBe(0);
    expect(s.text).toBe('1 UP');
  });
});

// --- patch reducer ----------------------------------------------------------

describe('applyPatch', () => {
  it('clamps strokes into a sane range and reports change', () => {
    const m = twoPlayerMatch();
    expect(applyPatch(m, { setScore: { playerId: 'A', hole: 0, strokes: 99 } })).toBe(true);
    expect(m.scores.A[0]).toBe(20);
    expect(applyPatch(m, { setScore: { playerId: 'A', hole: 0, strokes: 0 } })).toBe(true);
    expect(m.scores.A[0]).toBe(1);
  });

  it('is a no-op (returns false) when nothing changes', () => {
    const m = twoPlayerMatch();
    applyPatch(m, { setScore: { playerId: 'A', hole: 0, strokes: 4 } });
    expect(applyPatch(m, { setScore: { playerId: 'A', hole: 0, strokes: 4 } })).toBe(false);
  });

  it('toggles the hitting indicator', () => {
    const m = twoPlayerMatch();
    expect(applyPatch(m, { setHitting: { playerId: 'A' } })).toBe(true);
    expect(m.hittingPlayerId).toBe('A');
    expect(applyPatch(m, { setHitting: { playerId: null } })).toBe(true);
    expect(m.hittingPlayerId).toBeNull();
  });

  it('rejects a score for an unknown player', () => {
    const m = twoPlayerMatch();
    expect(applyPatch(m, { setScore: { playerId: 'ghost', hole: 0, strokes: 4 } })).toBe(false);
  });

  it('resizing to 9 holes keeps existing scores and renumbers stroke index 1..9', () => {
    const m = twoPlayerMatch();
    setScores(m, 'A', [4, 5]);
    applyPatch(m, { setHoleCount: { holeCount: 9 } });
    expect(m.holeCount).toBe(9);
    expect(m.scores.A.length).toBe(9);
    expect(m.scores.A[0]).toBe(4);
    expect([...m.strokeIndex].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
