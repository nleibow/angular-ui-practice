// Shared live scorecard. Optimized for "one hand, between shots": tap a hole
// cell to open a big stepper keypad, tap a number, done. Shows gross/net per
// hole, running totals, and the match-play status banner.

import { useMemo, useState } from 'react';
import type { Match, PlayerId } from '@rangemate/shared';
import {
  matchPlayStatus,
  netOnHole,
  strokePlayTotals,
  strokesReceivedOnHole,
} from '@rangemate/shared';

interface Props {
  match: Match;
  selfId: PlayerId;
  onSetScore: (playerId: PlayerId, hole: number, strokes: number | null) => void;
  onSetHandicap: (playerId: PlayerId, handicap: number) => void;
}

export function Scorecard({ match, selfId, onSetScore, onSetHandicap }: Props) {
  const [editing, setEditing] = useState<{ playerId: PlayerId; hole: number } | null>(null);

  const players = match.order.map((id) => match.players[id]).filter(Boolean);
  const [pA, pB] = match.order;

  const status = useMemo(
    () => (pA && pB ? matchPlayStatus(match, pA, pB) : null),
    [match, pA, pB],
  );

  const statusLine = useMemo(() => {
    if (!status || !pA || !pB) return 'Waiting for your opponent to join…';
    if (status.leaderId == null) return status.text;
    const leader = match.players[status.leaderId]?.name ?? '?';
    return status.closed ? `${leader} wins ${status.text}` : `${leader} ${status.text}`;
  }, [status, match.players, pA, pB]);

  const holes = [...Array(match.holeCount).keys()];
  const front = holes.slice(0, 9);
  const back = holes.slice(9);

  return (
    <div className="scorecard">
      <div className={`match-status ${status?.closed ? 'closed' : ''}`}>{statusLine}</div>

      {[front, back].filter((nine) => nine.length > 0).map((nine, nineIdx) => (
        <table key={nineIdx} className="nine">
          <thead>
            <tr>
              <th className="rowhead">{nineIdx === 0 ? 'Hole' : 'Hole'}</th>
              {nine.map((h) => (
                <th key={h}>{h + 1}</th>
              ))}
              <th className="tot">{nineIdx === 0 ? 'OUT' : 'IN'}</th>
              {nineIdx === 1 && <th className="tot">TOT</th>}
            </tr>
            <tr className="meta">
              <th className="rowhead">Par</th>
              {nine.map((h) => (
                <th key={h}>{match.par[h]}</th>
              ))}
              <th className="tot">{nine.reduce((s, h) => s + match.par[h], 0)}</th>
              {nineIdx === 1 && <th className="tot">{match.par.reduce((a, b) => a + b, 0)}</th>}
            </tr>
            <tr className="meta si">
              <th className="rowhead">SI</th>
              {nine.map((h) => (
                <th key={h}>{match.strokeIndex[h]}</th>
              ))}
              <th className="tot" />
              {nineIdx === 1 && <th className="tot" />}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const totals = strokePlayTotals(match, p.id);
              const nineGross = nine.reduce((s, h) => s + (match.scores[p.id]?.[h] ?? 0), 0);
              const nineHasAny = nine.some((h) => match.scores[p.id]?.[h] != null);
              return (
                <tr key={p.id} className={p.id === selfId ? 'self' : ''}>
                  <td className="rowhead player-cell">
                    <span className="pname">{p.name}</span>
                    <button
                      className="hcp"
                      title="Tap to change handicap"
                      onClick={() => {
                        const raw = prompt(`${p.name}'s course handicap:`, String(p.handicap));
                        if (raw == null) return;
                        const n = Number(raw);
                        if (!Number.isNaN(n)) onSetHandicap(p.id, n);
                      }}
                    >
                      HCP {p.handicap}
                    </button>
                  </td>
                  {nine.map((h) => {
                    const gross = match.scores[p.id]?.[h] ?? null;
                    const dots = strokesReceivedOnHole(p.handicap, match.strokeIndex[h], match.holeCount);
                    const net = netOnHole(gross, p.handicap, match.strokeIndex[h], match.holeCount);
                    const toPar = gross != null ? gross - match.par[h] : null;
                    return (
                      <td
                        key={h}
                        className={`score ${scoreClass(toPar)}`}
                        onClick={() => setEditing({ playerId: p.id, hole: h })}
                      >
                        <span className="gross">{gross ?? ''}</span>
                        {dots > 0 && <span className="dots">{'•'.repeat(Math.min(dots, 3))}</span>}
                        {gross != null && dots !== 0 && <span className="net">{net}</span>}
                      </td>
                    );
                  })}
                  <td className="tot">{nineHasAny ? nineGross : ''}</td>
                  {nineIdx === 1 && (
                    <td className="tot final">
                      {totals.grossThru > 0 ? (
                        <>
                          {totals.gross}
                          <span className="net-total">net {totals.net}</span>
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      ))}

      {editing && (
        <ScorePad
          match={match}
          playerId={editing.playerId}
          hole={editing.hole}
          onPick={(strokes) => {
            onSetScore(editing.playerId, editing.hole, strokes);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function scoreClass(toPar: number | null): string {
  if (toPar == null) return 'empty';
  if (toPar <= -2) return 'eagle';
  if (toPar === -1) return 'birdie';
  if (toPar === 0) return 'par';
  if (toPar === 1) return 'bogey';
  return 'double';
}

// Big-tap-target number pad, centered on par for the hole so the likely
// answers are one thumb-tap away.
function ScorePad({
  match,
  playerId,
  hole,
  onPick,
  onClose,
}: {
  match: Match;
  playerId: PlayerId;
  hole: number;
  onPick: (strokes: number | null) => void;
  onClose: () => void;
}) {
  const par = match.par[hole];
  const name = match.players[playerId]?.name ?? '';
  const options = [];
  for (let s = Math.max(1, par - 2); s <= par + 5; s++) options.push(s);

  return (
    <div className="pad-overlay" onClick={onClose}>
      <div className="pad" onClick={(e) => e.stopPropagation()}>
        <div className="pad-title">
          {name} — hole {hole + 1} (par {par})
        </div>
        <div className="pad-grid">
          {options.map((s) => (
            <button
              key={s}
              className={`pad-btn ${s === par ? 'is-par' : ''} ${s === par - 1 ? 'is-birdie' : ''}`}
              onClick={() => onPick(s)}
            >
              {s}
              <span className="pad-label">{strokeLabel(s - par)}</span>
            </button>
          ))}
          <button className="pad-btn clear" onClick={() => onPick(null)}>
            ✕<span className="pad-label">clear</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function strokeLabel(toPar: number): string {
  if (toPar <= -3) return 'wow';
  if (toPar === -2) return 'eagle';
  if (toPar === -1) return 'birdie';
  if (toPar === 0) return 'par';
  if (toPar === 1) return 'bogey';
  if (toPar === 2) return 'double';
  return `+${toPar}`;
}
