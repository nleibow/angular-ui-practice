// Shared domain types for RangeMate. Imported by both client and server so the
// wire protocol and the Match state model are defined in exactly one place.

export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
  /** Course handicap (whole strokes). 16 => receives 16 net strokes over 18. */
  handicap: number;
  connected: boolean;
}

export interface Match {
  id: string;
  createdAt: number;
  holeCount: number; // 9 or 18
  par: number[]; // length === holeCount
  /** Stroke index per hole, values 1..holeCount, each used once. */
  strokeIndex: number[];
  players: Record<PlayerId, Player>;
  /** Stable column/seat order. */
  order: PlayerId[];
  /** Gross strokes per hole per player; null = not yet entered. */
  scores: Record<PlayerId, (number | null)[]>;
  /** Whose "is hitting" indicator is lit, or null. */
  hittingPlayerId: PlayerId | null;
  /** Monotonic; bumped on every server-applied change. */
  version: number;
}

// ---- WebSocket protocol ----------------------------------------------------

/** A shallow patch a client asks the server to apply to Match state. */
export interface MatchPatch {
  setScore?: { playerId: PlayerId; hole: number; strokes: number | null };
  setHandicap?: { playerId: PlayerId; handicap: number };
  setHitting?: { playerId: PlayerId | null };
  setHoleCount?: { holeCount: number };
}

export type ClientMessage =
  | { type: 'join'; roomId: string; playerId?: PlayerId; name: string; handicap: number }
  | { type: 'signal'; to: PlayerId; data: unknown }
  | { type: 'update'; patch: MatchPatch }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'joined'; selfId: PlayerId; roomId: string }
  | { type: 'state'; match: Match }
  | { type: 'peer'; event: 'joined' | 'left'; playerId: PlayerId }
  | { type: 'signal'; from: PlayerId; data: unknown }
  | { type: 'error'; message: string }
  | { type: 'pong' };
