# ⛳ RangeMate

Play a live round of golf with a friend — each of you at home on your own
Garmin R10 launch monitor and sim software. RangeMate is **not a simulator**:
it's the missing social layer. You watch each other's sim screens, talk trash,
and keep one shared scorecard, in real time.

**The play pattern:** you both load the *same course* in your own sim (e.g.
Garmin Home Tee Hero) and play the same holes at the same time. RangeMate
provides everything the sim won't: live video of your buddy's screen, voice,
a synced scorecard with handicaps and match-play status, and a "who's hitting"
indicator.

## Features (MVP)

- **Frictionless join** — create a match, text the link. No accounts. Name +
  handicap, playing in under a minute.
- **Two-way screen share + voice** — WebRTC peer-to-peer, low latency. Share
  the window running your sim (or a whole display).
- **Shared live scorecard** — gross + net per hole, stroke-play totals, and
  live match-play status ("2 UP thru 7", "DORMIE", "3 & 2"). Big tap targets,
  built for one hand between shots. Handicap strokes allocated by stroke index.
- **Turn system** — tap "My turn" when you step up; your buddy's view flips to
  theater mode (your sim fullscreen on their side) with a chime and a banner.
  Tap "Done — pass to Buddy" and the turn flips back, like honors on the tee.
- **Auto shot detection (no buttons)** — with your mic on, the app hears the
  crack of impact and logs the shot itself: your buddy's screen flashes into
  theater for the ball flight and the shot lands in a shared feed.
  Sensitivity: off / low / high.
- **Auto stat capture (beta)** — draw one box over where your sim shows the
  numbers (carry, ball speed…). After each detected shot the app OCRs the box
  and attaches the numbers to the shot feed — fuel for long-drive and
  closest-to-pin bragging. Fully self-hosted OCR, no cloud.
- **Mulligans** — everyone gets an allowance (default 3). Burn one with a tap;
  your buddy gets a toast announcing it. Usage shows on the scorecard, undoable.
- **Survives hiccups** — refresh mid-round and you're back in your seat with
  the full scorecard in under a second. Server restarts restore rounds from
  disk snapshots. Rounds last hours; connections don't.

## Quick start (local)

```bash
npm install
npm run dev        # client on http://localhost:5173, server on :5174
```

Open http://localhost:5173, create a match, open the invite link in a second
browser/profile to be player two.

Run the scorecard/match-logic tests:

```bash
npm test
```

Production build + run (single process serves everything on :5174):

```bash
npm run build
npm start
```

## Deploying (one small server + TURN)

RangeMate needs one tiny VPS (anything with Node 18+) and, ideally, a TURN
relay for the ~10–20% of home-network pairs whose NATs block direct
peer-to-peer media.

### 1. The app server

```bash
git clone <this repo> && cd rangemate
npm install && npm run build
PORT=5174 npm start
```

Put it behind any TLS proxy (Caddy is the least work — automatic HTTPS):

```
# Caddyfile
rangemate.example.com {
    reverse_proxy localhost:5174
}
```

HTTPS is **required** in production: browsers only allow screen capture and
microphone on secure origins.

### 2. TURN relay (recommended)

Without TURN, media is STUN/P2P only — most home pairs work, some won't.
Self-hosted [coturn](https://github.com/coturn/coturn) on the same VPS:

```bash
sudo apt install coturn
```

`/etc/turnserver.conf`:

```
listening-port=3478
fingerprint
lt-cred-mech
user=rangemate:choose-a-long-password
realm=rangemate.example.com
# total-quota / bandwidth caps are wise on small VPSes
```

Then start the app with TURN configured:

```bash
TURN_URL=turn:rangemate.example.com:3478 \
TURN_USERNAME=rangemate \
TURN_PASSWORD=choose-a-long-password \
PORT=5174 npm start
```

**Tradeoff:** P2P direct is lowest latency and free; TURN relays all media
through your server (a screen share is roughly 1–3 Mbit/s per direction) but
works behind any NAT. Managed alternatives (Twilio NTS, Metered, Cloudflare
TURN) work too — paste their URL/credentials into the same env vars. For 2–8
friends, a $5 VPS running both the app and coturn is plenty.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5174` | HTTP + WebSocket port |
| `DATA_DIR` | `./data` | Round snapshot files |
| `STUN_URLS` | Google STUN | Comma-separated STUN URLs |
| `TURN_URL` | *(unset)* | Comma-separated TURN URLs |
| `TURN_USERNAME` / `TURN_PASSWORD` | *(unset)* | TURN credentials |

## Playing with Home Tee Hero on an iPhone/iPad

Home Tee Hero runs in the Garmin Golf app on your phone or tablet, and iOS
doesn't let a browser capture another app's screen — so you mirror the device
to your Mac and share the mirror window. The chain:

**R10 → iPhone/iPad (HTH) → mirrored to the Mac → Chrome shares the mirror →
your buddy's screen.**

Two built-in ways to mirror:

- **AirPlay (wireless):** On the Mac, *System Settings → General → AirDrop &
  Handoff → AirPlay Receiver: On*. On the iPhone/iPad, open Control Center →
  **Screen Mirroring** → pick the Mac. HTH appears as a window on the Mac.
- **QuickTime (USB cable, most reliable):** Plug the device in, open
  QuickTime Player → *File → New Movie Recording* → click the ▾ next to the
  record button → select the iPhone/iPad as the camera. Don't record —
  it's just a live view window.

Then in RangeMate on the Mac: **Share sim screen** → choose the mirror window.
AirPlay adds ~0.1–0.2s of delay, which doesn't matter for watching a shot.

If your sim runs on the computer itself (GSPro, E6, Awesome Golf), skip all
this and share its window directly.

## Your first round (non-technical walkthrough)

1. **Both of you:** use **Chrome or Edge** on the computer that runs your sim.
   (Safari can't share a single window.)
2. **Player 1:** open the RangeMate site, enter your name and course handicap,
   tap **Create match**. Tap **copy invite link** and text it to your buddy.
3. **Player 2:** open the link, enter name + handicap, tap **Join match**.
4. **Both:** tap **Share sim screen** and pick the window running Home Tee
   Hero (or your sim of choice). Tap the mic button and allow the microphone.
   - **Mac users, first time only:** if sharing is blocked, go to
     *System Settings → Privacy & Security → Screen Recording*, enable your
     browser, then **quit and reopen the browser** and open your match link
     again. Your spot in the match is saved.
5. **Both:** load the *same course* in your sims and agree on tees.
6. Play golf. Tap **My turn** when you step up — your buddy's screen switches
   to yours automatically; tap **Done — pass** when your ball stops. With the
   mic on, the app also *hears* your strike and flashes your shot onto his
   screen by itself (tune it with the "Auto shot detect" switch).
   After each hole, tap your score on the card — the pad is centered on par.
   Blown shot? **Mulligan** — he'll be notified, don't worry.
7. Want live numbers in the feed? Tap **set box** and drag a rectangle over
   where your sim displays carry/ball speed, then **test read** to check it.
   After every detected shot those numbers post to the shared shot feed.
8. The banner shows the match: "AS thru 3", "2 UP thru 7", and the win
   ("3 & 2") when it's over. Net scoring uses your handicaps automatically —
   the gold dots on the card show where strokes fall.
9. If anything freezes: **refresh the page.** You'll be back in your seat with
   the scorecard intact in a second or two.

## How it works

```
Player A (browser) ──── WebRTC media (screen + voice) ──── Player B (browser)
        │              (P2P direct, or via TURN relay)              │
        └───── WebSocket ────► Node server ◄──── WebSocket ─────────┘
                    signaling relay + authoritative scorecard state
                            (JSON snapshots to ./data)
```

- Media never touches the app server — it only relays WebRTC signaling and
  owns the match state (scores, turn, handicaps), broadcasting on every change.
- Clients keep a per-room seat id in `localStorage`; rejoining reclaims the
  seat and receives a full state snapshot — that's the whole reconnect story.
- Scoring math (stroke allocation by stroke index, net match play, dormie/
  closeout notation) lives in `shared/` with unit tests: `npm test`.

## Repo layout

```
shared/   types + scoring/match logic (unit tested — the part that must not lie)
server/   Node: static hosting, /api/ice, WebSocket signaling + state
client/   React + Vite: lobby, video panes, controls, scorecard
```

## Roadmap (stretch)

- **Auto shot capture** — OCR a user-drawn screen region (ball speed / carry /
  total) after each shot into a shared feed; enables closest-to-pin and
  long-drive games. (No Garmin API exists — see `RESEARCH.md`.)
- Side games: skins, CTP on par 3s, long drive.
- Replay: buffer the last ~10s of your buddy's stream for instant rewatch.
- Match history.
