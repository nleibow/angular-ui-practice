// In-memory room registry with debounced JSON snapshots to disk. A "room" is a
// Match plus the live WebSocket connections of its players. Snapshots let a
// round survive a server restart; the full-state-on-join protocol lets a client
// survive a refresh.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { Match, MatchPatch, Player, PlayerId } from '@rangemate/shared';
import { createMatch, addPlayer, applyPatch, normalizeMatch } from '@rangemate/shared';

interface Connection {
  playerId: PlayerId;
  ws: WebSocket;
}

interface Room {
  match: Match;
  connections: Map<PlayerId, Connection>;
  saveTimer?: NodeJS.Timeout;
}

const MAX_PLAYERS = 2;

export class RoomStore {
  private rooms = new Map<string, Room>();

  constructor(private dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.loadFromDisk();
  }

  /** Get or lazily create a room. */
  private getOrCreate(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { match: createMatch(roomId), connections: new Map() };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /**
   * Attach a connection to a room, reclaiming an existing seat when a known
   * playerId reconnects. Returns the resolved player, or null if the room is
   * full with two *different* players.
   */
  join(
    roomId: string,
    ws: WebSocket,
    desired: { playerId?: PlayerId; name: string; handicap: number },
  ): { player: Player; match: Match } | { error: string } {
    const room = this.getOrCreate(roomId);
    const existing = desired.playerId && room.match.players[desired.playerId];

    if (!existing) {
      const seated = Object.keys(room.match.players).length;
      if (seated >= MAX_PLAYERS) {
        return { error: 'This match already has two players.' };
      }
    }

    const playerId = (desired.playerId && existing ? desired.playerId : randomId());
    const player: Player = existing
      ? { ...room.match.players[playerId], name: desired.name, handicap: desired.handicap, connected: true }
      : { id: playerId, name: desired.name, handicap: desired.handicap, connected: true };

    addPlayer(room.match, player);
    room.match.players[playerId].connected = true;

    // Drop any stale socket for this seat, then attach the new one.
    room.connections.get(playerId)?.ws.close();
    room.connections.set(playerId, { playerId, ws });

    room.match.version++;
    this.scheduleSave(roomId);
    return { player, match: room.match };
  }

  leave(roomId: string, playerId: PlayerId): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.connections.delete(playerId);
    if (room.match.players[playerId]) {
      room.match.players[playerId].connected = false;
      room.match.version++;
    }
    this.scheduleSave(roomId);
  }

  applyPatch(roomId: string, patch: MatchPatch): Match | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const changed = applyPatch(room.match, patch);
    if (changed) {
      room.match.version++;
      this.scheduleSave(roomId);
    }
    return room.match;
  }

  getMatch(roomId: string): Match | null {
    return this.rooms.get(roomId)?.match ?? null;
  }

  /** All connections in a room except an optional one to skip. */
  peers(roomId: string, except?: PlayerId): Connection[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.connections.values()].filter((c) => c.playerId !== except);
  }

  peer(roomId: string, playerId: PlayerId): Connection | undefined {
    return this.rooms.get(roomId)?.connections.get(playerId);
  }

  // --- persistence ----------------------------------------------------------

  private scheduleSave(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => this.save(roomId), 500);
  }

  private save(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    try {
      writeFileSync(this.filePath(roomId), JSON.stringify(room.match), 'utf8');
    } catch (err) {
      console.error(`Failed to snapshot room ${roomId}:`, err);
    }
  }

  private loadFromDisk(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.dataDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const raw = readFileSync(join(this.dataDir, f), 'utf8');
        const match = normalizeMatch(JSON.parse(raw) as Match);
        // Everyone is disconnected after a restart; connections rebuild on join.
        for (const p of Object.values(match.players)) p.connected = false;
        this.rooms.set(match.id, { match, connections: new Map() });
      } catch (err) {
        console.error(`Failed to load snapshot ${f}:`, err);
      }
    }
    if (this.rooms.size) console.log(`Restored ${this.rooms.size} room(s) from disk.`);
  }

  private filePath(roomId: string): string {
    return join(this.dataDir, `${sanitize(roomId)}.json`);
  }
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
