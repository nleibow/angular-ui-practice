// Thin client for the RangeMate WebSocket protocol. Owns the socket, reconnects
// with backoff, and re-joins with the saved playerId so a refresh or a network
// hiccup silently reclaims your seat and pulls the current match snapshot.

import type { ClientMessage, ServerMessage, Match, MatchPatch, PlayerId } from '@rangemate/shared';

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetHandlers {
  onJoined?: (selfId: PlayerId, roomId: string) => void;
  onState?: (match: Match) => void;
  onPeer?: (event: 'joined' | 'left', playerId: PlayerId) => void;
  onSignal?: (from: PlayerId, data: unknown) => void;
  onError?: (message: string) => void;
  onConn?: (s: ConnState) => void;
}

export class Net {
  private ws: WebSocket | null = null;
  private backoff = 500;
  private closedByUser = false;
  private selfId?: PlayerId;

  constructor(
    private roomId: string,
    private profile: { name: string; handicap: number },
    private handlers: NetHandlers,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.handlers.onConn?.(this.selfId ? 'reconnecting' : 'connecting');

    ws.onopen = () => {
      this.backoff = 500;
      this.handlers.onConn?.('open');
      this.sendJoin();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.dispatch(msg);
    };

    ws.onclose = () => {
      if (this.closedByUser) {
        this.handlers.onConn?.('closed');
        return;
      }
      this.handlers.onConn?.('reconnecting');
      setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };

    ws.onerror = () => ws.close();
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'joined':
        this.selfId = msg.selfId;
        savePlayerId(this.roomId, msg.selfId);
        this.handlers.onJoined?.(msg.selfId, msg.roomId);
        break;
      case 'state':
        this.handlers.onState?.(msg.match);
        break;
      case 'peer':
        this.handlers.onPeer?.(msg.event, msg.playerId);
        break;
      case 'signal':
        this.handlers.onSignal?.(msg.from, msg.data);
        break;
      case 'error':
        this.handlers.onError?.(msg.message);
        break;
      case 'pong':
        break;
    }
  }

  private sendJoin(): void {
    this.send({
      type: 'join',
      roomId: this.roomId,
      playerId: loadPlayerId(this.roomId),
      name: this.profile.name,
      handicap: this.profile.handicap,
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  signal(to: PlayerId, data: unknown): void {
    this.send({ type: 'signal', to, data });
  }

  update(patch: MatchPatch): void {
    this.send({ type: 'update', patch });
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}

// Persist the seat so a refresh reclaims it instead of taking a new one.
function key(roomId: string): string {
  return `rangemate:pid:${roomId}`;
}
export function loadPlayerId(roomId: string): string | undefined {
  return localStorage.getItem(key(roomId)) ?? undefined;
}
function savePlayerId(roomId: string, id: string): void {
  localStorage.setItem(key(roomId), id);
}
