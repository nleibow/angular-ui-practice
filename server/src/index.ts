// RangeMate signaling + state server. One process:
//   • serves the built client (single origin)
//   • /api/ice hands out STUN/TURN config from env
//   • /ws carries the JSON protocol: WebRTC signal relay + authoritative state
//
// Media (screen video + voice) is peer-to-peer and never passes through here.

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@rangemate/shared';
import { RoomStore, randomId } from './rooms.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 5174);
const DATA_DIR = process.env.DATA_DIR ?? resolve(__dirname, '../../data');
const CLIENT_DIR = resolve(__dirname, '../../client/dist');

const store = new RoomStore(DATA_DIR);

// --- ICE config from env ----------------------------------------------------
// STUN is always on. TURN is optional but strongly recommended (see README):
//   TURN_URL=turn:your.host:3478  TURN_USERNAME=rangemate  TURN_PASSWORD=secret
function iceServers() {
  const servers: RTCIceServerLike[] = [
    { urls: (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',') },
  ];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_PASSWORD,
    });
  }
  return servers;
}
interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// --- static file serving ----------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // SPA: resolve the file, fall back to index.html for client routes.
  let filePath = normalize(join(CLIENT_DIR, urlPath));
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(CLIENT_DIR, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end(
      'Client build not found. Run `npm run build` (production) or use the Vite dev server on :5173.',
    );
    return;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  res.end(body);
}

const httpServer = createServer((req, res) => {
  if (req.url === '/api/ice') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers: iceServers() }));
    return;
  }
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  serveStatic(req, res);
});

// --- WebSocket signaling + state --------------------------------------------
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

interface SocketState {
  roomId?: string;
  playerId?: string;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws: WebSocket) => {
  const state: SocketState = {};

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomId = msg.roomId.trim().slice(0, 40);
        if (!roomId) return send(ws, { type: 'error', message: 'Missing room id.' });
        const result = store.join(roomId, ws, {
          playerId: msg.playerId,
          name: (msg.name || 'Player').slice(0, 24),
          handicap: msg.handicap,
        });
        if ('error' in result) return send(ws, { type: 'error', message: result.error });

        state.roomId = roomId;
        state.playerId = result.player.id;
        send(ws, { type: 'joined', selfId: result.player.id, roomId });
        send(ws, { type: 'state', match: result.match });
        // Tell the other peer we arrived (so it can start WebRTC negotiation),
        // and broadcast fresh state (connected flags changed).
        for (const c of store.peers(roomId, result.player.id)) {
          send(c.ws, { type: 'peer', event: 'joined', playerId: result.player.id });
          send(c.ws, { type: 'state', match: result.match });
        }
        break;
      }

      case 'signal': {
        if (!state.roomId || !state.playerId) return;
        const target = store.peer(state.roomId, msg.to);
        if (target) send(target.ws, { type: 'signal', from: state.playerId, data: msg.data });
        break;
      }

      case 'update': {
        if (!state.roomId) return;
        const match = store.applyPatch(state.roomId, msg.patch);
        if (match) for (const c of store.peers(state.roomId)) send(c.ws, { type: 'state', match });
        break;
      }

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (state.roomId && state.playerId) {
      store.leave(state.roomId, state.playerId);
      const match = store.getMatch(state.roomId);
      for (const c of store.peers(state.roomId)) {
        send(c.ws, { type: 'peer', event: 'left', playerId: state.playerId });
        if (match) send(c.ws, { type: 'state', match });
      }
    }
  });
});

// Keep-alive: drop dead sockets so seats free up.
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.ping();
  }
}, 30000);

httpServer.listen(PORT, () => {
  console.log(`RangeMate server on http://localhost:${PORT}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  TURN:     ${process.env.TURN_URL ? 'configured' : 'NOT configured (P2P/STUN only)'}`);
});

export { randomId };
