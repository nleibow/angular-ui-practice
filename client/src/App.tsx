// RangeMate app shell. Two screens:
//   Lobby   — create a match or join via link, pick name + handicap.
//   Session — video panes (yours + theirs), voice, scorecard, turn indicator.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnState } from './net';
import { Net, loadPlayerId } from './net';
import type { Match, PlayerId } from '@rangemate/shared';
import { RtcSession, captureMic, captureScreen, fetchIceServers, isPermissionError } from './webrtc';
import { Scorecard } from './Scorecard';

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

export function App() {
  const [roomId, setRoomId] = useState<string | null>(roomIdFromUrl());
  const [profile, setProfile] = useState<{ name: string; handicap: number } | null>(() => {
    const raw = localStorage.getItem('rangemate:profile');
    return raw ? JSON.parse(raw) : null;
  });
  // Refresh recovery: if we already hold a seat in this room, skip the lobby
  // and rejoin immediately — mid-round refreshes must be seamless.
  const [joined, setJoined] = useState(() => {
    const rid = roomIdFromUrl();
    return rid != null && loadPlayerId(rid) != null;
  });

  if (!roomId || !joined || !profile) {
    return (
      <Lobby
        roomId={roomId}
        initialProfile={profile}
        onStart={(rid, prof) => {
          localStorage.setItem('rangemate:profile', JSON.stringify(prof));
          history.pushState(null, '', `/m/${rid}`);
          setProfile(prof);
          setRoomId(rid);
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
      <p className="hint">
        Works best in Chrome or Edge, on the computer running your sim.
      </p>
    </div>
  );
}

// --- Session -------------------------------------------------------------------

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

  const netRef = useRef<Net | null>(null);
  const rtcRef = useRef<RtcSession | null>(null);
  const iceRef = useRef<RTCIceServer[]>([]);
  const selfIdRef = useRef<PlayerId | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

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
        // A failed connection after a network change: tear down so the next
        // peer-joined (or our own reconnect) builds a fresh one.
        if (s === 'failed') {
          rtcRef.current?.close();
          rtcRef.current = null;
        }
      },
    });
    rtcRef.current = rtc;
    // Attach whatever media we already have.
    if (micStreamRef.current) rtc.setMic(micStreamRef.current);
    if (screenStreamRef.current) rtc.setScreen(screenStreamRef.current);
    return rtc;
  }, []);

  // Boot: fetch ICE config, open the socket.
  useEffect(() => {
    let disposed = false;
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
            // Rebuild the peer connection for a (re)joining opponent.
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
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

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
      // If the user stops sharing via the browser UI, reflect it.
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
      setMicOn(false);
      return;
    }
    try {
      const stream = await captureMic();
      micStreamRef.current = stream;
      rtcRef.current?.setMic(stream);
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

  const opponent = match && selfId ? match.order.filter((id) => id !== selfId).map((id) => match.players[id])[0] : null;
  const hitting = match?.hittingPlayerId ? match.players[match.hittingPlayerId] : null;
  const iAmHitting = match?.hittingPlayerId === selfId;

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

      {hitting && (
        <div className={`banner hitting ${iAmHitting ? 'me' : 'them'}`}>
          🏌️ {iAmHitting ? 'You are' : `${hitting.name} is`} hitting — heads up!
        </div>
      )}

      {/* Theater mode: while the opponent is hitting, their sim takes over the
          screen so you can't miss the shot; your own pane shrinks to a thumb. */}
      <div className={`videos ${match?.hittingPlayerId && !iAmHitting && opponent ? 'theater' : ''}`}>
        <div className={`pane remote ${match?.hittingPlayerId && !iAmHitting ? 'spotlight' : ''}`}>
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
        <div className={`pane local ${iAmHitting ? 'spotlight' : ''}`}>
          <video ref={localVideoRef} autoPlay playsInline muted />
          <div className="pane-label">You ({profile.name})</div>
          {!screenOn && (
            <div className="pane-empty">
              <p>Share the window running your sim.</p>
              <button className="primary" onClick={toggleScreen}>
                Share sim screen
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="controls">
        <button className={`ctl ${screenOn ? 'on' : ''}`} onClick={toggleScreen}>
          {screenOn ? '🖥 Sharing' : '🖥 Share screen'}
        </button>
        <button className={`ctl ${micOn ? 'on' : ''}`} onClick={toggleMic}>
          {micOn ? '🎙 Mic on' : '🔇 Mic off'}
        </button>
        <button
          className={`ctl hit ${iAmHitting ? 'on' : ''}`}
          disabled={!match || !selfId}
          onClick={() =>
            netRef.current?.update({ setHitting: { playerId: iAmHitting ? null : selfId } })
          }
        >
          {iAmHitting ? '🏌️ Done hitting' : '🏌️ I’m hitting'}
        </button>
      </div>

      {match && selfId && (
        <Scorecard
          match={match}
          selfId={selfId}
          onSetScore={(playerId, hole, strokes) =>
            netRef.current?.update({ setScore: { playerId, hole, strokes } })
          }
          onSetHandicap={(playerId, handicap) =>
            netRef.current?.update({ setHandicap: { playerId, handicap } })
          }
        />
      )}

      {showMacHelp && <MacHelp onClose={() => setShowMacHelp(false)} />}
    </div>
  );
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
