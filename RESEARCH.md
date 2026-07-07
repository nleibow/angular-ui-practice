# RESEARCH.md

Short research pass before building **RangeMate**. Two questions mattered:
(1) can a browser reliably share a sim window + mic over WebRTC, and
(2) does Garmin expose usable shot/round data so we could auto-capture scores?

_Last checked: July 2026._

---

## 1. Browser screen capture + WebRTC — confirmed viable

**`getDisplayMedia()` is the right primitive.** It prompts the user to pick a
**single application window**, an **entire display**, or a **browser tab**, and
returns a `MediaStream` we can push over an `RTCPeerConnection`. That covers the
prompt's "share one window" and "share one display" requirements directly.

Key facts that shaped the design:

- **Chrome / Edge / Opera**: full picker — window, display, or tab. This is the
  target. On macOS the browser must be granted **Screen Recording** permission
  in *System Settings → Privacy & Security → Screen Recording*, and the browser
  must be **restarted once** after granting it or the picker shows nothing
  shareable. This is an OS-level gate (introduced in macOS Catalina), not
  something we can prompt around — so we detect the failure and show clear
  first-run instructions in-app.
- **Firefox**: offers window/display but not tab; also historically broken when
  the browser is full-screen on macOS. Usable but not our primary target.
- **Safari**: no real picker — it only offers the current display, and
  "Display & Camera" capture is flaky. We steer users to Chrome/Edge.
- **Latency**: WebRTC media is real-time by design (sub-200ms on a P2P path).
  A golf shot is a ~5-second event, so we bias the encoder toward **low latency
  / lower resolution** rather than crisp 1080p. Screen-share tracks default to
  detail/text content-hint; we override toward motion + a modest framerate cap.
- **NAT traversal**: residential NAT means direct P2P often works via STUN, but
  symmetric NAT on one side forces a **TURN relay**. We ship a STUN default and
  document a self-hosted **coturn** (or managed) TURN fallback. Without TURN,
  ~10–20% of home-to-home pairs will fail to connect media.
- A proposed `getViewportMedia()` (pickerless current-tab capture) exists but is
  not broadly shipped; not needed here.

**Conclusion:** A web app in Chrome/Edge fully covers screen share + voice. No
native app required. Voice is just a mic audio track on the same peer
connection.

## 2. Garmin R10 / Home Tee Hero data access — no official API

The stretch goal (auto shot capture) hinges on getting numbers out of the sim.
Findings:

- **No official public API or SDK** for the Approach R10. Garmin has never
  released a Connect IQ SDK for it, and Golf Sim sessions have no documented
  developer endpoint. The **Garmin Connect Activity API** exists for fitness
  activities but does not surface launch-monitor shot data.
- **Manual export is per-session and clumsy**: in the Garmin Golf app you can
  open a Golf Sim session and export a file to a cloud drive. This is
  after-the-round, not live, and not per-shot in real time — useless for a live
  head-to-head feed.
- **Community workarounds exist and are the real path**: third-party tools read
  the R10 **directly over Bluetooth LE (GATT)** and relay shots to sim software
  (e.g. the open-source `gspro-garmin-connect-v2` connector, and various
  data-extract scripts). This proves per-shot data is obtainable, but only by a
  local companion process talking BLE — a browser tab can't do this reliably
  (Web Bluetooth is Chrome-only, fragile, and the R10 pairs to one host at a
  time, which the sim already holds).

**Conclusion:** For the MVP, **scores are entered manually** (fast tap targets).
For the stretch goal, the pragmatic auto-capture path is **screen-region OCR** of
the numbers the sim already renders (works regardless of sim, no BLE contention),
with a possible future **local BLE companion** for players not using a sim
overlay. We do **not** depend on any Garmin API.

---

## Sources

- MDN — MediaDevices.getDisplayMedia(): https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- W3C Screen Capture spec: https://www.w3.org/TR/screen-capture/
- Apple — Capturing screen content in macOS / ScreenCaptureKit: https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos
- Garmin Forums — R10 unlock API/SDK discussion: https://forums.garmin.com/developer/connect-iq/f/discussion/299194/garmin-approach-r10---unlock-api-interface-sdk
- Garmin Forums — R10 shot data via Web Bluetooth/GATT: https://forums.garmin.com/outdoor-recreation/golf/f/approach-r10/430937
- Garmin Connect Developer Program — Activity API: https://developer.garmin.com/gc-developer-program/activity-api/
- gspro-garmin-connect-v2 (BLE connector, community): https://github.com/travislang/gspro-garmin-connect-v2
- R10 data converter (community export script): https://github.com/earl553/garminr10dataconverter
