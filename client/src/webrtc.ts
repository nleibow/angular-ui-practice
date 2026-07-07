// One peer connection to the single remote player, carrying screen video + mic
// audio. Uses the "perfect negotiation" pattern so either side can add/remove
// tracks (start/stop screen share, mute) at any time without glare, and renegs
// cleanly after a reconnect.

import type { PlayerId } from '@rangemate/shared';
import type { Net } from './net';

interface RtcHandlers {
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
}

export class RtcSession {
  private pc: RTCPeerConnection;
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private micSender: RTCRtpSender | null = null;
  private screenSender: RTCRtpSender | null = null;
  private remoteStream = new MediaStream();

  constructor(
    selfId: PlayerId,
    private remoteId: PlayerId,
    private net: Net,
    iceServers: RTCIceServer[],
    private handlers: RtcHandlers,
  ) {
    // Deterministic, symmetric role assignment: same pair => same decision on
    // both machines. The "impolite" peer wins offer collisions.
    this.polite = selfId < remoteId;
    this.pc = new RTCPeerConnection({ iceServers });
    // A dummy data channel forces negotiation to start immediately, so the ICE
    // path is established even before either side adds mic/screen media.
    this.pc.createDataChannel('rangemate');

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.net.signal(this.remoteId, { description: this.pc.localDescription });
      } catch (err) {
        console.error('negotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.net.signal(this.remoteId, { candidate });
    };

    this.pc.ontrack = ({ track }) => {
      this.remoteStream.addTrack(track);
      track.onended = () => this.remoteStream.removeTrack(track);
      this.handlers.onRemoteStream(this.remoteStream);
    };

    this.pc.onconnectionstatechange = () => {
      this.handlers.onConnectionState(this.pc.connectionState);
    };
  }

  /** Handle an SDP/ICE payload relayed from the remote peer. */
  async onSignal(data: unknown): Promise<void> {
    const payload = data as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    try {
      if (payload.description) {
        const desc = payload.description;
        const offerCollision =
          desc.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;

        await this.pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await this.pc.setLocalDescription();
          this.net.signal(this.remoteId, { description: this.pc.localDescription });
        }
      } else if (payload.candidate) {
        try {
          await this.pc.addIceCandidate(payload.candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('onSignal error', err);
    }
  }

  /** Add or replace the mic audio track (null to remove). */
  setMic(stream: MediaStream | null): void {
    const track = stream?.getAudioTracks()[0] ?? null;
    this.applyTrack('mic', track, stream);
  }

  /** Add or replace the screen video track (null to stop sharing). */
  setScreen(stream: MediaStream | null): void {
    const track = stream?.getVideoTracks()[0] ?? null;
    this.applyTrack('screen', track, stream);
  }

  private applyTrack(kind: 'mic' | 'screen', track: MediaStreamTrack | null, stream: MediaStream | null): void {
    const senderRef = kind === 'mic' ? 'micSender' : 'screenSender';
    const sender = this[senderRef];
    if (sender) {
      if (track) {
        void sender.replaceTrack(track);
      } else {
        this.pc.removeTrack(sender); // triggers renegotiation
        this[senderRef] = null;
      }
    } else if (track && stream) {
      this[senderRef] = this.pc.addTrack(track, stream); // triggers renegotiation
    }
  }

  close(): void {
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.close();
  }
}

// --- media acquisition helpers ---------------------------------------------

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch('/api/ice');
    const json = await res.json();
    return json.iceServers as RTCIceServer[];
  } catch {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

export async function captureMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

export async function captureScreen(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // Bias toward motion + low latency over crisp text — a shot is a 5s event.
    video: { frameRate: { ideal: 24, max: 30 } } as MediaTrackConstraints,
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  if (track && 'contentHint' in track) track.contentHint = 'motion';
  return stream;
}

/** Best-effort detection of the macOS "no screen recording permission" case. */
export function isPermissionError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'NotFoundError');
}
