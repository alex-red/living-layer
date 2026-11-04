# Remote camera streaming

How to make the phone camera (and the other network cameras) as fast, sharp and dependable as the stack allows. Status: the network-camera path is the focus ([network cameras](#network-cameras)). The phone's phases 0 and 1 are built but not measured on a phone ([as built](#as-built-phases-0-and-1)); its phases 2 to 5 are on hold. Phone-to-server streaming waits until the live checks are done.

## Where it stands

- **Phone → tab, peer to peer.** The lab shows a QR code; the phone page (`remote-page.ts`) opens the back camera at 1280 × 720 and long-polls `/r/<token>/next`. The tab's `openStream` posts a receive-only WHEP offer to `/api/remote/<token>/whep`, the server hands it to the phone, and the phone's answer comes back. Media goes straight to the tab; the server only carries SDP (`remote.ts`).
- **Saved RTSP cameras** go through mediamtx (`relay.ts`): WHEP to the tab, RTSP on loopback to the watcher's ffmpeg. Without it, MJPEG.
- **The watcher** reads RTSP with one ffmpeg (`frames.ts`): 320 px grey at 10 fps over a pipe, plus a JPEG of up to 1280 px written twice a second for SAM.
- **The zoomed view** (`crop`) is cut by ffmpeg for saved cameras and by the tab (`cropStream`: video → canvas → `captureStream`) for WebRTC pictures.

What that costs:

1. **The server can't see a phone.** Watching without a tab, stills for SAM, and occupancy are unavailable for the cheapest camera there is.
2. **Defaults everywhere on the encode.** No codec choice, bitrate, `contentHint` or degradation preference, so the browser starts around 300 kbps, ramps up, and drops resolution first when it's short, which is the wrong trade for a fixed camera that's matched pixel by pixel.
3. **SAM sees the compressed 720p stream.** Across a room a mug is about 17 × 23 pixels (AGENTS.md). The phone's sensor has three to four times that resolution, which never reaches SAM.
4. **Auto exposure and white balance run free.** The template matcher and `pixelDifference` both get fooled when a light changes. An auto-exposure swing looks the same to them.
5. **Slow to start.** The pairing panel polls every 1.5 s, both sides wait up to 1.5 s for ICE gathering, and each "Use the phone camera" builds a new peer connection on the phone.
6. **The crop is a copy.** `cropStream` draws each frame onto a canvas and encodes it again for `captureStream`, and an ffprobe run (up to 10 s over RTSP) comes before the watcher's first frame.
7. **No numbers.** Nothing records time to first frame, glass-to-glass latency, freezes, or why the encoder limited quality.

## Network cameras

A saved RTSP camera, or one `scripts/share-camera.sh` serves, is read by the server's mediamtx relay (`relay.ts`). The relay gives WebRTC to the tab and loopback RTSP to the watcher's ffmpeg (`FfmpegSource`), which also takes the stills for SAM, the snapshot route and the MJPEG fallback. `bun run bench:stream` measures this path with no camera: a fake 1080p30 H.264 camera served by a local mediamtx, read straight and through the lab's own `CameraRelay`. `--url` measures a real camera instead.

### What a new reader waits for

Every new reader (the watcher starting, a still with nothing running, a tab's WebRTC) waits for:

1. **The connection.** RTSP over loopback through the relay, or the camera's own handshake and authentication when the relay's source is cold.
2. **ffmpeg's look at the stream.** By default it probes before decoding anything: about 1.1 s.
3. **The next keyframe.** Anywhere from nothing to the camera's whole keyframe interval, 2 s on many cameras and 4 s or more on some. The relay can't ask an RTSP camera for one, so this wait is the camera's to shorten.

Before this work, the watcher also ran ffprobe first to learn the frame size. That was a second connection and a second wait for a keyframe.

### As built

Measured with `bun run bench:stream --gop 0.2`, where keyframes come often enough that the code's own overhead shows. Medians of 10, on an M-series Mac:

| What                              | HEAD before          | Now                  |
| --------------------------------- | -------------------- | -------------------- |
| Watcher's first grey frame        | 2.28 s               | 0.69 s               |
| A still with no source running    | 1.25 s               | 0.6–0.7 s            |
| A still while the watcher runs    | 1.2 s                | 7 ms                 |
| The same three, through the relay | 2.27 / 1.28 / 1.22 s | 0.69 / 0.62 s / 8 ms |

With a 2 s keyframe interval, the default, the watcher's first frame went from about 4.2 s to 1–2 s. Most of what's left is the wait for a keyframe.

- **No ffprobe.** The watcher's grey frames come as YUV4MPEG (`-f yuv4mpegpipe`), whose header gives their size (`Y4mReader`). The camera is opened once. `start` still fails, as before, when the camera can't be opened: it resolves at the first frame, or rejects when ffmpeg exits first or after 20 s.
- **No probing for RTSP.** `-analyzeduration 0 -probesize 32`: an RTSP camera's stream description already carries the codec and size. A camera that leaves out the H.264 parameters makes ffmpeg exit at once, and the source opens again with the default probing. The one-off still does the same. The fake camera and the relay both include them.
- **Stills are shared.** A source that isn't running asks one that is reading the same URL and crop for its picture. The snapshot route builds its own source, so while the watcher reads a camera, its still is a file read instead of a new connection.
- **The relay keeps a camera open for a minute** after its last reader (`sourceOnDemandCloseAfter: 60s`, default 10 s), so a tab reloading, or a still soon after, doesn't reconnect to the camera.
- **The relay no longer opens Media over QUIC on every interface.** Newer mediamtx versions listen on `*:8892` (TCP and UDP) unless told otherwise. The relay was meant to be loopback only, and a second mediamtx couldn't start beside it. `MTX_MOQ=no` is set in the environment (`RELAY_ENV`), since an older mediamtx refuses a config key it doesn't know.
- Hardware decoding (`-hwaccel auto`, VideoToolbox) logs errors for the frames before the first keyframe. Its first still matches software decoding's picture, so nothing changed there.

### Next, by what each would save

- **Ask for a 1 s keyframe interval on the camera.** It's a setting in the camera's own app. It halves the wait for every new reader and costs a few percent more bitrate. `bench:stream --url` reports the interval. The lab could warn when a saved camera's interval is over 2 s.
- **Watch on the camera's substream.** Most IP cameras give a second, small stream (640 × 360 at 10–15 fps). The watcher only needs 320-px grey frames, so decoding 1080p30 to get them throws away most of the work. That's the decoding cost, not the 2–3% ffmpeg CPU the bench shows on a Mac with hardware decoding, which hides it. Stills for SAM would still come from the main stream. A saved camera gets an optional second URL. The substream must have the main stream's aspect ratio for the crop and calibration to carry over; check that when it's saved.
- **Packet loss from a real camera.** The live relay's log shows `RTP packets lost` and `invalid FU-A packet` from one camera, over TCP. Over TCP, that is the camera dropping packets before they're sent, usually a Wi-Fi link that can't carry its bitrate. Each loss smears frames until the next keyframe, which the watcher sees as motion. Lower that camera's bitrate, or use its substream for watching. A count of lost packets per camera, from mediamtx's API, would make this visible in the lab.
- **The tab's WebRTC start.** It waits for a keyframe like everyone else, and the relay can't ask for one. `openStream` now logs its time to first frame (`bun run runs --streams`), so measure it on real cameras before doing more.
- **Not worth it now:** scaling on the GPU (`scale_vt`). The bench's ffmpeg CPU is 2–3% with hardware decoding already.

## Phase 0: measure (half a day)

You can't optimize what nobody has measured, and phone behaviour differs by model, so take the numbers before changing anything.

- **Tab.** Extend the 2 s `getStats` poll in `openStream` to keep a summary: time from `openStream` to first decoded frame, fps, bitrate, `jitterBufferDelay / jitterBufferEmittedCount`, `freezeCount` and `totalFreezesDuration`, `totalDecodeTime`, the codec and `decoderImplementation`. Send it to the run log on close so `bun run runs` shows it.
- **Phone.** Every 5 s the page posts its `outbound-rtp` stats (`qualityLimitationReason`, `encoderImplementation`, `powerEfficientEncoder`, frame size and fps, `targetBitrate`) to a new `/r/<token>/stats` route. Thermal state has no web API, so a falling frame rate under `qualityLimitationReason: cpu` stands in for it.
- **Glass to glass.** Where the browser offers `requestVideoFrameCallback` metadata with `captureTime` (from the `abs-capture-time` RTP extension), read the latency directly. Elsewhere, point the phone at a millisecond clock on the lab's screen and compare the two in one screenshot.
- **Server.** Time from `Watcher.start` to the first grey frame, the age of each frame on arrival, and ffmpeg's CPU.
- **Baseline matrix.** One iPhone (Safari) and one Android (Chrome), on 5 GHz and on 2.4 GHz Wi-Fi, sending to a Chrome and a Safari tab: 10 minutes each with the mug moved every 30 s. Write the results into this file.

**Proposed targets** (to confirm against the baseline):

| What                                            | Target       |
| ----------------------------------------------- | ------------ |
| "Use the phone camera" to first frame           | < 500 ms     |
| Glass to glass, tab, LAN                        | < 150 ms     |
| Age of a watcher frame                          | < 200 ms     |
| Freezes over 500 ms, 10 min on good Wi-Fi       | 0            |
| Plugged-in phone, 1 h                           | no fps drop  |
| Mug size in a SAM still, same place in the room | ≥ 3× today's |

## Phase 1: tune the path we have (one day, hackathon-safe)

These are all changes to the phone page and `streams.ts`. The architecture stays as it is.

- **Pick the encoder deliberately.** On the phone, order the codecs with `transceiver.setCodecPreferences`: hardware H.264 (High profile, `packetization-mode=1`) first. Try HEVC or AV1 first only when `navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', … })` reports `powerEfficient` for both ends. A software AV1 encode on a phone overheats it within minutes.
- **Tell it what the picture is for.** `track.contentHint = 'detail'`. Then call `sender.setParameters` with `degradationPreference: 'maintain-resolution'`, `maxBitrate` around 4–6 Mbps (it's a LAN), and `maxFramerate: 30`. A fixed camera hardly changes between frames, so the bitrate goes to detail rather than motion. Check each setting is honoured in the phase 0 stats: Safari's support for some of these is partial.
- **Lock the camera** once the person marks it fixed. Where `getCapabilities()` offers them (mostly Chrome on Android), apply `exposureMode`, `whiteBalanceMode` and `focusMode: 'manual'` at the values the camera settled on. That removes the auto-exposure swings that look like change to `pixelDifference` and the template matcher. Unlock it again on "Switch camera" or a new calibration.
- **Start faster.**
  - The pairing panel listens on server-sent events instead of polling every 1.5 s.
  - Both sides send their SDP once they have a host candidate, or after 300 ms, rather than waiting 1.5 s for gathering to finish: on a LAN the host candidate is what's used.
  - The phone keeps its `RTCPeerConnection` between offers and only renegotiates.
- **Recover in place.** When `iceConnectionState` turns `disconnected`, as on a Wi-Fi roam, the tab calls `restartIce()` and sends the new offer through the same route, before falling back to `onLost`.
- **Ask for a keyframe at once.** Have the phone send a keyframe as soon as a new viewer connects. Today the first frame waits for the next keyframe interval.

### As built (phases 0 and 1)

- **One log for all three.** `stream-stats.jsonl` in the data directory, one JSON line per measurement (`appendStreamStats` in `store.ts`). `bun run runs --streams` prints the latest of each with medians.
  - **Tab:** `openStream` logs each playback when it closes, is lost or fails, via `POST /api/streams/stats`, with any pairing token cut from the path. Time to connect, time to the first decoded frame (polled every 30 ms, not every 2 s), fps, kbps, jitter-buffer wait, freezes, decode time per frame, size, codec and decoder.
  - **Phone:** posts its `outbound-rtp` report every 10 s to `/r/<token>/stats`. The lab keeps the latest one (`pairing.sending` in `/api/remote`), and the log keeps one every 30 s, so an always-on phone writes about 120 lines an hour.
  - **Watcher:** logs each live run of the camera when it stops, is lost or restarts: time to open the source, time to the first grey frame, frames, fps and the longest gap. Demo runs aren't logged.
- **Not built yet.** The age of each watcher frame (ffmpeg's raw frames carry no timestamps), automatic glass-to-glass latency, and ffmpeg's CPU. The clock-on-the-screen method still stands for latency.
- **The codec is chosen in the lab's offer, not on the phone.** Tried in Chrome 152 with two local peers: when only the answering phone preferred H.264, it still sent VP8, because a sender follows the offer's order. `openStream` now offers H.264 (`packetization-mode=1`) first, for every WHEP stream. A relay serves its camera's own codec whatever the order. HEVC and AV1 wait for phase 0's numbers.
- **Sender settings.** `contentHint = 'detail'`, `degradationPreference: 'maintain-resolution'`, 5 Mbps and 30 fps at most. Chrome kept all of them in the same trial. Safari is untested; the phone's stats (`limitedBy`, `targetKbps`, size) show what it did. Capture stays at 1280 × 720, since a new frame size would invalidate existing calibrations.
- **Holding exposure is a button on the phone page** (`Hold exposure`), not tied to marking the camera fixed. That would need a server-to-phone event, which waits for phase 3's control channel. The button is shown only where the camera offers a `manual` mode for exposure, white balance or focus (so not in iOS Safari), keeps their current values, and is reset by `Switch camera`. The phone's stats say whether it is held.
- **The pairing panel** follows `GET /api/remote/events`, sent on each change and every 5 s (a phone that went away is only noticed by time), and falls back to polling if the event stream fails.
- **Dropped, as it doesn't apply.**
  - Keeping the phone's `RTCPeerConnection` between offers: each offer comes from a new peer connection in the lab, so it can't be renegotiated.
  - Asking for a keyframe: a new connection starts a new encoder, whose first frame is a keyframe.
- **Moved to phase 2:** ICE restart (WHIP's `PATCH` carries it) and the shorter ICE gathering wait. With no STUN server configured, gathering covers host candidates only and should end within milliseconds. `connectMs` in the log will show whether the 1.5 s cap is ever reached.

## Phase 2: the phone publishes to the relay (WHIP)

`tracking.md` already names this as the way to watch a phone without a tab. WHIP is RFC 9725, and mediamtx accepts it on `/<path>/whip`.

- **Publish once.** When the person marks it as the camera, the phone publishes into the relay's `phone` path. The tab plays from the relay over loopback, exactly like a saved camera, and the watcher's `FfmpegSource` reads `rtsp://127.0.0.1:<port+1>/phone`. Reopening the tab or switching cameras no longer touches the phone, and its encoder runs once however many read it.
- **Signalling** still goes through the phone server, so the lab's API stays loopback-only. `POST /r/<token>/whip`, plus `PATCH` for trickle and `DELETE`, is forwarded to mediamtx on loopback, under the pairing's token. The relay accepts publishing only on `phone`, only from loopback (the forwarder) and only while the pairing lives. Its config gets `webrtcAdditionalHosts: [<lan address>]` so the phone can reach the media UDP port. That port is the one thing newly opened to the LAN, so state that in the pairing steps.
- **One code path.** The phone becomes a saved camera in all but storage: `streams()` lists it with the relay's `whep` and `rtsp`. The server cuts the crop for the watcher, as `FfmpegSource.cut` already does, and `Follow locally` is no longer needed for phones. Remove the peer-to-peer branch once phase 0's numbers show the relay costs less than 20 ms.
- **The watcher starts faster.**
  - Skip ffprobe when the publisher reported its size (the phone posts it with its stats).
  - Add `-fflags nobuffer -flags low_delay -probesize 32k -analyzeduration 0` for loopback RTSP.
  - With phone stills coming from phase 3, the 2 fps JPEG writer is only kept for saved cameras.

## Phase 3: a control channel and full-resolution stills

The phone's long-poll already carries events from the server; give it more kinds.

- **`still`.** When SAM needs a picture (confirm, re-anchor, a scan, "Find the desk"), the server asks the phone for one. Where offered (Chrome on Android), the phone uses `ImageCapture.takePhoto()` at full sensor resolution. Elsewhere it opens its track at the highest size `getCapabilities()` gives, sends a scaled copy (`scaleResolutionDownBy`), and draws a full-size frame from the track. Either way it posts a JPEG, cut to the crop, to `/r/<token>/still/<id>`. With a 4K capture the mug is around 50 × 70 pixels instead of 17 × 23, which is what the item fitter and appearance layer have been missing. Fall back to the relay's frame if the phone doesn't answer within 1.5 s.
- **`tune`.** The watcher drives the sender's `maxFramerate` and `maxBitrate`. While nothing in any zone moved for a minute, 5 fps at a low bitrate; on motion, 30 fps at full bitrate. An always-on phone runs cooler, and the frames that matter are sharp. Motion is noticed on the very next frame at either rate.
- **`moved`.** The phone listens to `devicemotion` and reports a jolt. Every zone and pin assumes a fixed camera, so a bumped phone pauses rules and asks for a check of the calibration at once, rather than waiting for the camera-moved check to notice.
- **Battery.** The page reports `navigator.getBattery()` where it exists, and the lab warns when an unplugged phone is the watched camera.

## Phase 4: crop without copying, in the tab

- In browsers with `MediaStreamTrackProcessor` and `VideoTrackGenerator` (check Safari's current support), `cropStream` moves to a worker. There each `VideoFrame` becomes `new VideoFrame(frame, { visibleRect })`, a view onto the same GPU frame, with no canvas and no second encode. The canvas path stays as the fallback.
- Where a phone offers the `zoom` constraint, a crop that is a centred zoom is done by the camera instead: the sensor's pixels go to the crop rather than being thrown away after encoding. Calibration with `crop` then needs to know the zoom, so leave this until after phase 3.

## Phase 5 (experiment): WebCodecs over WebTransport or MoQ

This only goes ahead if phase 2 misses its targets, or the metadata in phase 3 proves too awkward to carry beside WebRTC.

- The phone encodes with `VideoEncoder` (WebCodecs; in Safari since 16.4) and sends each chunk with its capture time, exposure and device motion over WebTransport, or through a Media over QUIC relay. The server gets encoded frames and metadata together, can ask for a keyframe or a lossless still on its own stream, and decodes with VideoToolbox.
- **What it buys:** per-frame metadata, encoding fully under our control, and stills on the same connection.
- **What it costs:**
  - WebRTC's congestion control and loss recovery, which we would rebuild.
  - A QUIC server beside Bun's HTTP.
  - Safari's WebTransport support, which is recent and needs checking on the phones we test.
  - MoQ is still an IETF draft.
- **Decide by** the phase 0 matrix: keep it only if it beats the WHIP path by more than 50 ms glass to glass, or holds 30 fps where WebRTC drops to `qualityLimitationReason: bandwidth`.

## Not doing

- **LL-HLS or DASH:** seconds of latency.
- **MJPEG from the phone:** roughly ten times the bytes of H.264 for the same picture.
- **TURN:** the phone and lab share a LAN, and the pairing page says so.
- **SAM video:** It stays parked until its latency and billable frames are measured.
- **A native app:** the web page covers what's needed except a full-sensor still on iOS, which phase 3's large-track still approximates.

## Checks

- Unit tests:
  - the WHIP forwarder: token, path and loopback checks, and expiry with the pairing;
  - the `still` and `tune` events in `RemoteCamera`;
  - the ffmpeg arguments for loopback RTSP.
- `bun run browser` gets a fake-camera phone page, Chromium's `--use-fake-device-for-media-stream`, publishing through the relay, with the lab tab and watcher both receiving.
- `bun run bench:track` before and after phases 2 and 3. Watcher cost and SAM asks must not rise.
- Run the phase 0 matrix again after each phase and add the numbers here.
