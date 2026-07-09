// RangeMate app shell. Two screens:
//   Lobby   — create a match or join via link, pick name + handicap.
//   Session — video panes, voice, auto shot detection + OCR stats, scorecard,
//             turn system with pass semantics, mulligans, shot feed.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnState } from './net';
import { Net, loadPlayerId } from './net';
import type { Match, PlayerId, ShotEvent } from '@rangemate/shared';
import { currentHole } from '@rangemate/shared';
import { RtcSession, captureMic, captureScreen, fetchIceServers, isPermissionError } from './webrtc';
import { Scorecard } from './Scorecard';
import { ImpactDetector, type Sensitivity } from './impact';
import {
  type Region,
  paneRectToRegion,
  regionToPaneRect,
  readRegionText,
  parseSimStats,
  preloadOcr,
} from './ocr';
import { chimeYourTurn, blip } from './sound';

// --- routing: /m/:roomId ------------------------------------------------------

function roomIdFromUrl(): string | null {
  const m = location.pathname.match(/^\/m\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function newRoomId(): string {
  const words = ['fade', 'draw', 'flush', 'shank', 'stinger', 'chunk', 'flop', 'punch'];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.random().toString(36).slice(2, 7)}`;
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function App() {
  const [roomId, setRoomId] = useState<string | null>(roomIdFromUrl());
  const [profile, setProfile] = useState<{ name: string; handicap: number } | null>(() => {
    const raw = localStorage.getItem('rangemate:profile');
    return raw ? JSON.parse(raw) : null;
  });
  // Refresh recovery: if we already hold a seat in this room, skip the lobby
  // and rejoin immediately — mid-round refreshes must be seamless.
  const [joined, setJoined] = useState(() => {
    const r = roomIdFromUrl();
    return r != null && loadPlayerId(r) != null;
  });

  if (!roomId || !joined || !profile) {
    return (
      <Lobby
        roomId={roomId}
        initialProfile={profile}
        onStart={(r, prof) => {
          localStorage.setItem('rangemate:profile', JSON.stringify(prof));
          history.pushState(null, '', `/m/${r}`);
          setProfile(prof);
          setRoomId(r);
          setJoined(true);
        }}
      />
    );
  }

  return <Session roomId={roomId} profile={profile} />;
}

// --- Lobby -------------------------------------------------------------------

function Lobby({
  roomId,
  initialProfile,
  onStart,
}: {
  roomId: string | null;
  initialProfile: { name: string; handicap: number } | null;
  onStart: (roomId: string, profile: { name: string; handicap: number }) => void;
}) {
  const [name, setName] = useState(initialProfile?.name ?? '');
  const [handicap, setHandicap] = useState(String(initialProfile?.handicap ?? 0));
  const joining = roomId != null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onStart(roomId ?? newRoomId(), { name: name.trim(), handicap: Number(handicap) || 0 });
  };

  return (
    <div className="lobby">
      <h1>⛳ RangeMate</h1>
      <p className="tagline">
        {joining
          ? 'You’ve been challenged. Enter your name and step up.'
          : 'Play a live round with a friend — each of you on your own sim.'}
      </p>
      <form onSubmit={submit}>
        <label>
          Display name
          <input
            autoFocus
            value={name}
            maxLength={24}
            placeholder="Nate"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Course handicap
          <input
            type="number"
            inputMode="numeric"
            value={handicap}
            min={-10}
            max={54}
            onChange={(e) => setHandicap(e.target.value)}
          />
        </label>
        <button type="submit" className="primary">
          {joining ? 'Join match' : 'Create match'}
        </button>
      </form>
      <p className="hint">Works best in Chrome or Edge, on the computer running your sim.</p>
    </div>
  );
}

// --- Session -------------------------------------------------------------------

const SHOT_FLASH_MS = 10000; // theater linger after an opponent's shot
const OCR_DELAY_MS = 3500; // wait for the sim to render numbers post-impact

function Session({ roomId, profile }: { roomId: string; profile: { name: string; handicap: number } }) {
  const [selfId, setSelfId] = useState<PlayerId | null>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [rtcState, setRtcState] = useState<RTCPeerConnectionState | 'none'>('none');
  const [error, setError] = useState<string | null>(null);
  const [screenOn, setScreenOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [showMacHelp, setShowMacHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [shotFlashUntil, setShotFlashUntil] = useState(0);
  const [, forceTick] = useState(0);
  const [sensitivity, setSensitivity] = useState<Sensitivity>(
    () => (localStorage.getItem('rangemate:sens') as Sensitivity) ?? 'high',
  );
  const [region, setRegion] = useState<Region | null>(() => {
    const raw = localStorage.getItem(`rangemate:ocr:${roomId}`);
    return raw ? JSON.parse(raw) : null;
  });
  const [pickingRegion, setPickingRegion] = useState(false);
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);

  const netRef = useRef<Net | null>(null);
  const rtcRef = useRef<RtcSession | null>(null);
  const iceRef = useRef<RTCIceServer[]>([]);
  const selfIdRef = useRef<PlayerId | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localPaneRef = useRef<HTMLDivElement>(null);
  const detectorRef = useRef<ImpactDetector | null>(null);
  const seenShotsRef = useRef<Set<string> | null>(null); // null until first state
  const prevHittingRef = useRef<PlayerId | null>(null);
  const prevMullRef = useRef<Record<string, number>>({});
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const regionRef = useRef(region);
  regionRef.current = region;

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const ensureRtc = useCallback((remoteId: PlayerId) => {
    const self = selfIdRef.current;
    const net = netRef.current;
    if (!self || !net) return null;
    if (rtcRef.current) return rtcRef.current;
    const rtc = new RtcSession(self, remoteId, net, iceRef.current, {
      onRemoteStream: (stream) => {
        if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== stream) {
          remoteVideoRef.current.srcObject = stream;
        }
      },
      onConnectionState: (s) => {
        setRtcState(s);
        if (s === 'failed') {
          rtcRef.current?.close();
          rtcRef.current = null;
        }
      },
    });
    rtcRef.current = rtc;
    if (micStreamRef.current) rtc.setMic(micStreamRef.current);
    if (screenStreamRef.current) rtc.setScreen(screenStreamRef.current);
    return rtc;
  }, []);

  // OCR pass for one of *my* shots: snapshot my sim region, attach stats.
  const runOcrForShot = useCallback(
    async (shotId: string | null): Promise<void> => {
      const video = localVideoRef.current;
      const reg = regionRef.current;
      if (!video || !reg) return;
      setOcrBusy(true);
      try {
        const text = await readRegionText(video, reg);
        const stats = parseSimStats(text);
        if (shotId && Object.keys(stats).length > 0) {
          netRef.current?.update({ setShotStats: { id: shotId, stats } });
        } else if (!shotId) {
          // Test read: show what the box sees so it can be positioned live.
          const pretty = Object.entries(stats)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' · ');
          showToast(pretty ? `📷 ${pretty}` : `📷 Nothing readable — move/resize the stats box`);
        }
      } catch (err) {
        console.warn('ocr failed', err);
        if (!shotId) showToast('📷 OCR failed — see console');
      } finally {
        setOcrBusy(false);
      }
    },
    [showToast],
  );

  // Boot: fetch ICE config, open the socket, arm the impact detector.
  useEffect(() => {
    let disposed = false;
    detectorRef.current = new ImpactDetector(() => {
      const self = selfIdRef.current;
      if (!self) return;
      const id = rid();
      netRef.current?.update({ addShot: { id, playerId: self, auto: true } });
      // Give the sim a beat to paint the numbers, then read them.
      if (regionRef.current) setTimeout(() => void runOcrForShot(id), OCR_DELAY_MS);
    });
    detectorRef.current.sensitivity = sensitivity;

    (async () => {
      iceRef.current = await fetchIceServers();
      if (disposed) return;
      const net = new Net(roomId, profile, {
        onJoined: (id) => {
          selfIdRef.current = id;
          setSelfId(id);
        },
        onState: (m) => setMatch(m),
        onPeer: (event, playerId) => {
          if (event === 'joined') {
            rtcRef.current?.close();
            rtcRef.current = null;
            ensureRtc(playerId);
          }
        },
        onSignal: (from, data) => {
          const rtc = ensureRtc(from);
          void rtc?.onSignal(data);
        },
        onError: (message) => setError(message),
        onConn: setConn,
      });
      netRef.current = net;
      net.connect();
    })();
    return () => {
      disposed = true;
      netRef.current?.close();
      rtcRef.current?.close();
      detectorRef.current?.stop();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Turn-change cues: chime when it becomes my turn, blip when it's theirs.
  useEffect(() => {
    if (!match || !selfId) return;
    const prev = prevHittingRef.current;
    const cur = match.hittingPlayerId;
    if (prev !== cur) {
      if (cur === selfId && prev !== null) chimeYourTurn();
      else if (cur && cur !== selfId) blip();
      prevHittingRef.current = cur;
    }
  }, [match, selfId]);

  // Shot feed reactions: theater-flash + blip on opponent shots; OCR handled
  // at detection time for our own. Skip everything already in the snapshot at
  // join time so a refresh doesn't replay history.
  useEffect(() => {
    if (!match || !selfId) return;
    if (seenShotsRef.current === null) {
      seenShotsRef.current = new Set(match.shots.map((s) => s.id));
      return;
    }
    const seen = seenShotsRef.current;
    for (const shot of match.shots) {
      if (seen.has(shot.id)) continue;
      seen.add(shot.id);
      if (shot.playerId !== selfId) {
        setShotFlashUntil(Date.now() + SHOT_FLASH_MS);
        blip();
        const name = match.players[shot.playerId]?.name ?? 'Opponent';
        showToast(`🏌️ ${name} hit a shot — watch!`);
      } else if (shot.auto) {
        showToast('🎯 Shot detected');
      }
    }
  }, [match, selfId, showToast]);

  // Mulligan reactions.
  useEffect(() => {
    if (!match || !selfId) return;
    for (const [pid, used] of Object.entries(match.mulligansUsed)) {
      const prev = prevMullRef.current[pid] ?? used; // no toast on first sync
      if (used > prev) {
        const name = match.players[pid]?.name ?? 'Someone';
        const left = match.mulliganAllowance - used;
        showToast(pid === selfId ? `🔄 Mulligan burned — ${left} left` : `😂 ${name} took a mulligan (${left} left)`);
      }
      prevMullRef.current[pid] = used;
    }
  }, [match, selfId, showToast]);

  // Keep the theater flash timer honest.
  useEffect(() => {
    if (shotFlashUntil <= Date.now()) return;
    const t = setTimeout(() => forceTick((n) => n + 1), shotFlashUntil - Date.now() + 50);
    return () => clearTimeout(t);
  });

  // Persist detector sensitivity + keep the detector in sync.
  useEffect(() => {
    localStorage.setItem('rangemate:sens', sensitivity);
    if (detectorRef.current) detectorRef.current.sensitivity = sensitivity;
  }, [sensitivity]);

  // Debug/testing hook: lets the console (or an E2E test) inject patches,
  // e.g. window.__rm.update({ addShot: { id: 'x', playerId: window.__rm.selfId } })
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__rm = {
      selfId,
      update: (p: Parameters<Net['update']>[0]) => netRef.current?.update(p),
    };
  }, [selfId]);

  const toggleScreen = async () => {
    if (screenOn) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      rtcRef.current?.setScreen(null);
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      setScreenOn(false);
      return;
    }
    try {
      const stream = await captureScreen();
      screenStreamRef.current = stream;
      rtcRef.current?.setScreen(stream);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setScreenOn(true);
      preloadOcr();
      stream.getVideoTracks()[0].onended = () => {
        screenStreamRef.current = null;
        rtcRef.current?.setScreen(null);
        if (localVideoRef.current) localVideoRef.current.srcObject = null;
        setScreenOn(false);
      };
    } catch (err) {
      if (isPermissionError(err)) setShowMacHelp(true);
    }
  };

  const toggleMic = async () => {
    if (micOn) {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      rtcRef.current?.setMic(null);
      detectorRef.current?.stop();
      setMicOn(false);
      return;
    }
    try {
      const stream = await captureMic();
      micStreamRef.current = stream;
      rtcRef.current?.setMic(stream);
      detectorRef.current?.start(stream);
      setMicOn(true);
    } catch {
      setError('Microphone unavailable — check browser permissions.');
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable; the URL bar still works */
    }
  };

  // --- OCR region picking on the local pane ---
  const paneMouse = (e: React.PointerEvent): { x: number; y: number } => {
    const box = localPaneRef.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const onPanePointerDown = (e: React.PointerEvent) => {
    if (!pickingRegion) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragStartRef.current = paneMouse(e);
    setDragRect({ ...dragStartRef.current, w: 0, h: 0 });
  };
  const onPanePointerMove = (e: React.PointerEvent) => {
    if (!pickingRegion || !dragStartRef.current) return;
    const cur = paneMouse(e);
    const s = dragStartRef.current;
    setDragRect({
      x: Math.min(s.x, cur.x),
      y: Math.min(s.y, cur.y),
      w: Math.abs(cur.x - s.x),
      h: Math.abs(cur.y - s.y),
    });
  };
  const onPanePointerUp = () => {
    if (!pickingRegion || !dragRect || !localPaneRef.current || !localVideoRef.current) return;
    const pane = localPaneRef.current.getBoundingClientRect();
    const reg = paneRectToRegion(
      { width: pane.width, height: pane.height },
      localVideoRef.current,
      dragRect,
    );
    dragStartRef.current = null;
    setDragRect(null);
    setPickingRegion(false);
    if (reg) {
      setRegion(reg);
      localStorage.setItem(`rangemate:ocr:${roomId}`, JSON.stringify(reg));
      showToast('📦 Stats box saved — test it with “Test read”');
    } else {
      showToast('Box too small — drag a rectangle over the sim’s numbers');
    }
  };

  const savedRegionRect =
    region && localPaneRef.current && localVideoRef.current && screenOn
      ? regionToPaneRect(
          {
            width: localPaneRef.current.getBoundingClientRect().width,
            height: localPaneRef.current.getBoundingClientRect().height,
          },
          localVideoRef.current,
          region,
        )
      : null;

  // --- derived view state ---
  const opponent =
    match && selfId ? match.order.filter((id) => id !== selfId).map((id) => match.players[id])[0] : null;
  const iAmHitting = match?.hittingPlayerId === selfId;
  const oppHitting = opponent != null && match?.hittingPlayerId === opponent.id;
  const shotFlash = shotFlashUntil > Date.now();
  const theater = (oppHitting || shotFlash) && opponent != null;
  const hole = match ? currentHole(match) : 0;
  const mullLeft = match && selfId ? match.mulliganAllowance - (match.mulligansUsed[selfId] ?? 0) : 0;
  const setupNeeded = !screenOn || !micOn || !opponent;

  const claimOrPass = () => {
    if (!match || !selfId) return;
    if (iAmHitting) {
      netRef.current?.update({ setHitting: { playerId: opponent ? opponent.id : null } });
    } else {
      netRef.current?.update({ setHitting: { playerId: selfId } });
    }
  };

  return (
    <div className="session">
      <header>
        <div className="brand">⛳ RangeMate</div>
        <div className="header-status">
          <span className={`pill conn-${conn}`}>{connLabel(conn)}</span>
          {opponent && <span className={`pill rtc-${rtcState}`}>video: {rtcState}</span>}
          <button className="pill link" onClick={copyLink}>
            {copied ? '✓ copied' : 'copy invite link'}
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error} <span className="dismiss">✕</span>
        </div>
      )}

      {/* First-run setup: three taps and you're live. */}
      {setupNeeded && (
        <div className="setup">
          <button className={`step ${screenOn ? 'done' : ''}`} onClick={toggleScreen}>
            <span className="step-n">{screenOn ? '✓' : '1'}</span> Share your sim
          </button>
          <button className={`step ${micOn ? 'done' : ''}`} onClick={toggleMic}>
            <span className="step-n">{micOn ? '✓' : '2'}</span> Turn on voice
          </button>
          <button className={`step ${opponent ? 'done' : ''}`} onClick={copyLink}>
            <span className="step-n">{opponent ? '✓' : '3'}</span>{' '}
            {opponent ? `${opponent.name} is here` : copied ? 'Link copied — text it!' : 'Invite your buddy'}
          </button>
        </div>
      )}

      {/* Turn banner: always know whose ball it is. */}
      {opponent && match && (
        <div className={`turn-banner ${iAmHitting ? 'mine' : oppHitting || shotFlash ? 'theirs' : 'idle'}`}>
          <span className="turn-hole">
            Hole {hole + 1} · Par {match.par[hole]}
          </span>
          <span className="turn-text">
            {shotFlash && !iAmHitting
              ? `👀 ${opponent.name} just hit — watch the flight!`
              : iAmHitting
                ? '🏌️ Your turn — hit when ready'
                : oppHitting
                  ? `👀 ${opponent.name} is up — watch the screen`
                  : 'Tap “My turn” when you step up'}
          </span>
        </div>
      )}

      <div className={`videos ${theater ? 'theater' : ''}`}>
        <div className={`pane remote ${oppHitting || shotFlash ? 'spotlight' : ''}`}>
          <video ref={remoteVideoRef} autoPlay playsInline />
          <div className="pane-label">
            {opponent ? `${opponent.name}${opponent.connected ? '' : ' (disconnected)'}` : 'Waiting for opponent…'}
          </div>
          {!opponent && (
            <div className="pane-empty">
              <p>Send your buddy the invite link:</p>
              <code>{location.href}</code>
            </div>
          )}
        </div>
        <div
          ref={localPaneRef}
          className={`pane local ${iAmHitting ? 'spotlight' : ''} ${pickingRegion ? 'picking' : ''}`}
          onPointerDown={onPanePointerDown}
          onPointerMove={onPanePointerMove}
          onPointerUp={onPanePointerUp}
        >
          <video ref={localVideoRef} autoPlay playsInline muted />
          <div className="pane-label">You ({profile.name})</div>
          {!screenOn && (
            <div className="pane-empty">
              <p>Share the window running your sim.</p>
              <button className="primary" onClick={toggleScreen}>
                Share sim screen
              </button>
              <p className="pane-hint">
                Home Tee Hero on an iPhone/iPad? Mirror it to this Mac first (Control Center → Screen
                Mirroring, or QuickTime over USB), then share the mirror window.
              </p>
            </div>
          )}
          {pickingRegion && (
            <div className="pick-hint">Drag a box over where your sim shows the shot numbers</div>
          )}
          {dragRect && (
            <div
              className="region-box dragging"
              style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }}
            />
          )}
          {!dragRect && savedRegionRect && (
            <div
              className="region-box"
              style={{
                left: savedRegionRect.x,
                top: savedRegionRect.y,
                width: savedRegionRect.w,
                height: savedRegionRect.h,
              }}
            />
          )}
        </div>
      </div>

      <div className="controls">
        <button
          className={`ctl hit ${iAmHitting ? 'on' : ''}`}
          disabled={!match || !selfId}
          onClick={claimOrPass}
        >
          {iAmHitting ? (opponent ? `✅ Done — pass to ${opponent.name}` : '✅ Done') : '🏌️ My turn'}
        </button>
        <button
          className="ctl"
          disabled={!match || !selfId || mullLeft <= 0}
          onClick={() => selfId && netRef.current?.update({ useMulligan: { playerId: selfId, delta: 1 } })}
        >
          🔄 Mulligan{match ? ` (${mullLeft} left)` : ''}
        </button>
        <button className={`ctl ${screenOn ? 'on' : ''}`} onClick={toggleScreen}>
          {screenOn ? '🖥 Sharing' : '🖥 Share screen'}
        </button>
        <button className={`ctl ${micOn ? 'on' : ''}`} onClick={toggleMic}>
          {micOn ? '🎙 Mic on' : '🔇 Mic off'}
        </button>
      </div>

      {/* Auto-capture toolbar: impact detection + OCR stats box. */}
      <div className="capture-bar">
        <span className="cap-label">🎯 Auto shot detect</span>
        <div className="seg">
          {(['off', 'low', 'high'] as Sensitivity[]).map((s) => (
            <button
              key={s}
              className={`seg-btn ${sensitivity === s ? 'on' : ''}`}
              onClick={() => setSensitivity(s)}
            >
              {s}
            </button>
          ))}
        </div>
        {!micOn && sensitivity !== 'off' && <span className="cap-note">needs mic on</span>}
        <span className="cap-sep" />
        <span className="cap-label">📷 Stats box (beta)</span>
        <button
          className="seg-btn wide"
          disabled={!screenOn}
          onClick={() => {
            setPickingRegion((p) => !p);
            setDragRect(null);
          }}
        >
          {pickingRegion ? 'cancel' : region ? 'move box' : 'set box'}
        </button>
        <button
          className="seg-btn wide"
          disabled={!screenOn || !region || ocrBusy}
          onClick={() => void runOcrForShot(null)}
        >
          {ocrBusy ? 'reading…' : 'test read'}
        </button>
        {!screenOn && <span className="cap-note">share your screen first</span>}
      </div>

      {match && match.shots.length > 0 && <ShotFeed match={match} selfId={selfId} />}

      {match && selfId && (
        <Scorecard
          match={match}
          selfId={selfId}
          currentHole={hole}
          onSetScore={(playerId, h, strokes) =>
            netRef.current?.update({ setScore: { playerId, hole: h, strokes } })
          }
          onSetHandicap={(playerId, handicap) =>
            netRef.current?.update({ setHandicap: { playerId, handicap } })
          }
          onUndoMulligan={(playerId) =>
            netRef.current?.update({ useMulligan: { playerId, delta: -1 } })
          }
        />
      )}

      {toast && <div className="toast">{toast}</div>}
      {showMacHelp && <MacHelp onClose={() => setShowMacHelp(false)} />}
    </div>
  );
}

// --- Shot feed ------------------------------------------------------------------

function ShotFeed({ match, selfId }: { match: Match; selfId: PlayerId | null }) {
  const recent = [...match.shots].reverse().slice(0, 6);
  return (
    <div className="shot-feed">
      {recent.map((s: ShotEvent) => {
        const name = match.players[s.playerId]?.name ?? '?';
        const mine = s.playerId === selfId;
        return (
          <div key={s.id} className={`shot ${mine ? 'mine' : ''}`}>
            <span className="shot-who">
              {mine ? 'You' : name}
              {s.auto ? ' 🎯' : ''}
            </span>
            <span className="shot-when">{timeAgo(s.at)}</span>
            {s.stats ? (
              <span className="shot-stats">
                {Object.entries(s.stats).map(([k, v]) => (
                  <span key={k} className="stat-chip">
                    {k} <b>{v}</b>
                  </span>
                ))}
              </span>
            ) : (
              <span className="shot-stats none">shot</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function connLabel(c: ConnState): string {
  switch (c) {
    case 'connecting':
      return 'connecting…';
    case 'open':
      return 'connected';
    case 'reconnecting':
      return 'reconnecting…';
    case 'closed':
      return 'offline';
  }
}

function MacHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="pad-overlay" onClick={onClose}>
      <div className="pad help" onClick={(e) => e.stopPropagation()}>
        <div className="pad-title">Screen sharing is blocked</div>
        <p>On a Mac, the browser needs the OS-level Screen Recording permission:</p>
        <ol>
          <li>
            Open <b>System Settings → Privacy &amp; Security → Screen Recording</b>
          </li>
          <li>Turn on your browser (Chrome, Edge…)</li>
          <li>
            <b>Quit and reopen the browser</b> — the permission only takes effect after a restart
          </li>
          <li>Come back to this page (your match link) and hit “Share sim screen” again</li>
        </ol>
        <p className="hint">Your scorecard and seat in the match are saved — nothing is lost.</p>
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}
