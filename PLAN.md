# PLAN.md — RangeMate

## Product in one line

Two friends, each with a Garmin R10 + sim software at home, play a live
head-to-head round from separate houses: they **watch each other's sim screen**,
**talk**, and keep **one shared scorecard** — without the app ever touching golf
physics. We work *around* the sim, not replace it.

## The play pattern: "mirrored rounds"

Home Tee Hero is a closed app — no mod hooks, so true injected multiplayer is
off the table. The private-app workaround that gets ~90% of the feel: both
players load the **same real course** in their own HTH instance and play the
same holes simultaneously. RangeMate provides the missing connective tissue
(each other's screens, voice, one scorecard, turn indicator). Since this app is
private (2–8 friends, never for sale), the stretch goals can be as hacker-y as
needed — community reverse-engineering of the R10's BLE protocol
(`gspro-garmin-connect-v2` et al.) proves per-shot data is obtainable via a
local companion process, and screen-region OCR works regardless of sim.
If true shared-state multiplayer is ever wanted, E6 Connect and GSPro already
support remote peer play with the R10 — switching sims beats fighting Garmin.

## Chosen stack (and why)

| Layer | Choice | Why |
| --- | --- | --- |
| Client | **React + TypeScript + Vite** | Runs in Chrome/Edge next to the sim on a Mac, and on an iPad as a second screen. No install, no app store. |
| Real-time media | **WebRTC** (screen video + mic audio) | P2P low latency; the only browser primitive that does live A/V + screen share. |
| Signaling + state sync | **One Node server, `ws` WebSocket** | Same socket carries SDP/ICE relay *and* authoritative scorecard state. One process, cheap to host. |
| Shared logic | **`shared/` TS package** | Scoring/match-play math imported by both client and server, unit-tested once. |
| NAT traversal | **STUN default + coturn TURN fallback** | Direct P2P when NAT allows; relay when it doesn't. Documented tradeoff. |
| Persistence | **In-memory rooms + JSON snapshot to disk** | Rounds last 2h+; state survives a server restart and any client refresh. No DB to run. |

**Why not a SaaS realtime service (Firebase/Ably/etc.)?** Overkill and adds cost
for 2–8 friends. A single ~$5 VPS running the Node server + coturn is enough and
keeps everything self-hostable.

**Why server-authoritative state (not P2P CRDT)?** The scorecard must survive one
side refreshing or dropping mid-round. A tiny authoritative server with
full-snapshot-on-reconnect is far simpler and more robust than reconciling P2P
state, and we already need the server for signaling.

## Architecture

```
   Player A (Chrome, next to sim)                 Player B (Chrome, next to sim)
   ┌───────────────────────────┐                 ┌───────────────────────────┐
   │  RangeMate web client      │                 │  RangeMate web client      │
   │  • screen capture + mic    │                 │  • screen capture + mic    │
   │  • scorecard UI            │                 │  • scorecard UI            │
   └───────┬───────────▲────────┘                 └────────▲───────────┬──────┘
           │ WS (signal│+ state)                    (signal │+ state) WS│
           │           │                                    │           │
           ▼           │                                    │           ▼
        ┌──────────────┴────────────────────────────────────┴──────────────┐
        │   RangeMate server (Node + ws)                                    │
        │   • relays SDP/ICE between the two peers                          │
        │   • holds authoritative Match state, broadcasts on every change   │
        │   • snapshots rooms to data/*.json (survives restart)             │
        │   • serves the built client (single origin, single port)         │
        └───────────────────────────────────────────────────────────────────┘
                    ▲                                          ▲
                    │  WebRTC media (screen video + voice)     │
                    └──────── P2P direct ─────────────────────┘
                                     │  (if NAT blocks P2P)
                                     ▼
                          ┌────────────────────┐
                          │  coturn TURN relay  │  ← media relayed here as fallback
                          └────────────────────┘
```

Signaling / state protocol (JSON over the one WebSocket):

- `join` → server replies `joined` (assigns/echoes a persistent playerId) + full
  `state` snapshot, and tells the existing peer a `peer joined`.
- `signal` → relayed verbatim to the other peer (SDP offer/answer, ICE). Media
  itself never touches the server.
- `update` → server applies a patch to Match state, bumps `version`, broadcasts
  `state` to everyone in the room.
- Reconnect: client re-sends `join` with its saved playerId → gets the current
  snapshot → UI rebuilds. WebRTC re-negotiates via perfect-negotiation.

## Data model

```ts
Match {
  id: string
  createdAt: number
  holeCount: 9 | 18
  par: number[]            // per hole
  strokeIndex: number[]    // 1..holeCount, handicap allocation order
  players: {               // max 2 for MVP
    [playerId]: { id, name, handicap, connected }
  }
  order: playerId[]        // seating / column order, stable
  scores: { [playerId]: (number|null)[] }   // gross strokes per hole
  hittingPlayerId: string | null            // "X is hitting" indicator
  version: number
}
```

Derived (computed in `shared/scoring.ts`, never stored):
- per-hole **strokes received** from course handicap + stroke index
- **net** per hole and totals (stroke play)
- **match-play status**: holes up/down, `thru`, "2 UP", "AS", closeout "3 & 2"

**Handicap model:** each player's course handicap allocates strokes hole-by-hole
(`floor(hcp/18)` on every hole, +1 on holes whose strokeIndex ≤ `hcp % holeCount`).
Match play compares **net** scores per hole (net match play). Documented so it's
not "silently wrong."

## MVP task breakdown (vertical slices)

- [x] **Slice 0 — scaffold + docs.** Monorepo, shared scoring lib + tests, server, client shell.
- [x] **Slice A — media.** Create/join via link, exchange screens both ways, voice. Perfect-negotiation WebRTC, STUN, TURN config hook.
- [x] **Slice B — scorecard.** Server-authoritative Match state, big tap targets, live sync, stroke + match-play status, handicaps/net.
- [x] **Slice C — turn indicator.** "X is hitting" toggle synced to both.
- [x] **Slice D — polish + resilience.** Reconnect/refresh recovery (auto-rejoin
  from saved seat), macOS permission help modal, connection status pills, TURN
  docs in README. Verified: 22 unit tests + a WebSocket protocol smoke test +
  a two-browser Playwright run (join → score sync → turn banner → refresh
  recovery, WebRTC `connected` between the two contexts).

## Stretch (after MVP is solid, not tonight)

- Screen-region OCR of the sim's ball-speed/carry/total → shared shot feed.
- Side games: skins, closest-to-pin (par 3s), long drive.
- 10-second replay buffer of the partner's stream.
- Session history.

## Decisions / assumptions (things I chose without asking)

- **2 players** for MVP (prompt says "two friends"). State model is per-room; a
  small change lifts the cap later.
- **No accounts.** Identity = display name + a playerId persisted in
  `localStorage` (used to reclaim your seat on refresh).
- **Chrome/Edge** is the supported browser (Safari screen-share is too limited).
- **Net match play** (compare net per hole) rather than the "strokes off the
  low handicapper" convention — simpler, intuitive, same winner in most rounds.
- Default course = 18 holes, par 72, a standard men's stroke-index layout;
  editable isn't in MVP but the data model supports it.
