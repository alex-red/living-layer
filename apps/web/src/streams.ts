import { useCallback, useEffect, useState } from 'react';
import type { CameraCrop, CameraScene } from '@livinglayer/domain';
import { api } from './api';

/**
 * A camera shared on the LAN with `scripts/share-camera.sh`, a paired phone or
 * a camera saved by its stream URL, as `/api/streams` lists it. A phone's
 * `whep` is a path on the lab server; a saved camera has none, only an MJPEG
 * `preview` the server relays and a `snapshot` path for single frames.
 */
export interface NetworkStream {
  id: string;
  name: string;
  host: string;
  whep: string;
  /** A URL the server can read, so it can watch this camera. Passwords are hidden. */
  rtsp?: string;
  /** The room a saved camera is assigned to. */
  scene?: CameraScene;
  /**
   * Its zoomed view, kept on the server. A saved camera's preview and stills
   * come already cut to it; a phone's WebRTC picture is cut here, by `cropStream`.
   */
  crop?: CameraCrop | null;
  snapshot?: string;
  /** An MJPEG stream of a saved camera, relayed by the server. */
  preview?: string;
  source: 'mdns' | 'config' | 'phone' | 'saved';
}

export interface OpenedStream {
  media: MediaStream;
  /** Stops the track, closes the peer connection and ends the server session. */
  close: () => void;
}

/** Lists network cameras on mount and on `scan`. A failed scan just lists none. */
export function useNetworkStreams() {
  const [streams, setStreams] = useState<NetworkStream[]>([]);
  const [scanning, setScanning] = useState(false);
  /** Whether the first scan has answered, so a missing camera is known to be missing. */
  const [loaded, setLoaded] = useState(false);
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setStreams((await api<{ streams: NetworkStream[] }>('streams')).streams);
    } catch {
      setStreams([]);
    } finally {
      setScanning(false);
      setLoaded(true);
    }
  }, []);
  useEffect(() => void scan(), [scan]);
  return { streams, scanning, loaded, scan };
}

/** How long a connected stream may go without a frame before it counts as lost. */
const STALL_MS = 8000;

/** What one playback measured, as the server logs it (`bun run runs --streams`). */
interface PlaybackStats {
  stream: string;
  outcome: 'closed' | 'lost' | 'failed';
  error?: string;
  connectMs: number | null;
  firstFrameMs: number | null;
  durationMs: number | null;
  frames: number | null;
  fps: number | null;
  kbps: number | null;
  jitterMs: number | null;
  freezes: number | null;
  freezeMs: number | null;
  decodeMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  decoder: string | null;
}

/** The video's inbound report and its codec, from one `getStats`. */
async function inboundVideo(
  pc: RTCPeerConnection,
): Promise<Record<string, number | string | undefined> | null> {
  const report = await pc.getStats().catch(() => null);
  let found: Record<string, number | string | undefined> | null = null;
  report?.forEach((s: Record<string, number | string | undefined>) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') found = s;
  });
  const inbound = found as Record<string, number | string | undefined> | null;
  const codec = inbound?.codecId ? report?.get(String(inbound.codecId)) : null;
  return inbound && { ...inbound, mimeType: codec?.mimeType as string | undefined };
}

const round = (n: number | null, places = 0) =>
  n === null || !Number.isFinite(n) ? null : Number(n.toFixed(places));

/** Sends a playback's numbers to the server's log; one that can't be sent is dropped. */
function report(stats: PlaybackStats) {
  void fetch('/api/streams/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stats),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Plays a WHEP endpoint as a receive-only WebRTC stream. The offer goes out once
 * ICE gathering is done (instant on a LAN), so no trickle PATCHes are needed.
 * `onLost` fires once if the connection drops after it was up, or stops
 * bringing frames. How the playback went (time to connect and to the first
 * frame, rate, freezes, codec) is logged on the server when it ends.
 */
export async function openStream(
  endpoint: string,
  onLost: () => void,
  timeoutMs = 8000,
): Promise<OpenedStream> {
  const whep = new URL(endpoint, window.location.href).href;
  const pc = new RTCPeerConnection();
  const startedAt = performance.now();
  let connectedAt = 0;
  let firstFrameAt = 0;
  let last: Awaited<ReturnType<typeof inboundVideo>> = null;
  let reported = false;
  let session = '';
  let watch = 0;
  const measure = (outcome: PlaybackStats['outcome'], error?: string) => {
    if (reported) return;
    reported = true;
    const n = (key: string) => (typeof last?.[key] === 'number' ? (last[key] as number) : null);
    const text = (key: string) => {
      const value = last?.[key];
      return typeof value === 'string' ? value.slice(0, 60) : null;
    };
    const frames = n('framesDecoded');
    const playedMs = firstFrameAt ? performance.now() - firstFrameAt : null;
    const emitted = n('jitterBufferEmittedCount');
    report({
      // A phone's pairing token is in its path; it has no place in a log.
      stream: new URL(whep).pathname.replace(/[\w-]{24,}/g, '…').slice(0, 200),
      outcome,
      ...(error ? { error: error.slice(0, 200) } : {}),
      connectMs: round(connectedAt ? connectedAt - startedAt : null),
      firstFrameMs: round(firstFrameAt ? firstFrameAt - startedAt : null),
      durationMs: round(connectedAt ? performance.now() - connectedAt : null),
      frames,
      fps: round(frames && playedMs ? (frames * 1000) / playedMs : null, 1),
      kbps: round(
        n('bytesReceived') !== null && playedMs ? (n('bytesReceived')! * 8) / playedMs : null,
      ),
      jitterMs: round(
        emitted && n('jitterBufferDelay') !== null
          ? (n('jitterBufferDelay')! * 1000) / emitted
          : null,
        1,
      ),
      freezes: n('freezeCount'),
      freezeMs: round(
        n('totalFreezesDuration') !== null ? n('totalFreezesDuration')! * 1000 : null,
      ),
      decodeMs: round(
        frames && n('totalDecodeTime') !== null ? (n('totalDecodeTime')! * 1000) / frames : null,
        2,
      ),
      width: n('frameWidth'),
      height: n('frameHeight'),
      codec: text('mimeType'),
      decoder: text('decoderImplementation'),
    });
  };
  const close = () => {
    window.clearInterval(watch);
    measure('closed');
    pc.getReceivers().forEach((r) => r.track.stop());
    pc.close();
    if (session) void fetch(session, { method: 'DELETE' }).catch(() => {});
  };
  try {
    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    // Play frames as soon as they decode: this feeds a motion gate, not a film.
    if ('jitterBufferTarget' in transceiver.receiver) transceiver.receiver.jitterBufferTarget = 0;
    const track = new Promise<MediaStreamTrack>((resolve) =>
      pc.addEventListener('track', (e) => resolve(e.track), { once: true }),
    );
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
      });
      setTimeout(resolve, 1500);
    });
    const response = await fetch(whep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription!.sdp,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`The network camera answered ${response.status}.`);
    const location = response.headers.get('Location');
    if (location) session = new URL(location, whep).href;
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    const connected = new Promise<void>((resolve, reject) => {
      const check = () => {
        if (pc.connectionState === 'connected') resolve();
        if (pc.connectionState === 'failed') reject(new Error('No media path to the camera.'));
      };
      pc.addEventListener('connectionstatechange', check);
      check();
      setTimeout(() => reject(new Error('The network camera did not connect in time.')), timeoutMs);
    });
    const media = new MediaStream([await track]);
    await connected;
    connectedAt = performance.now();
    let lost = false;
    const lose = () => {
      if (lost) return;
      lost = true;
      window.clearInterval(watch);
      measure('lost');
      onLost();
    };
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(pc.connectionState)) lose();
    });
    // The first decoded frame, looked for closely so the time to it means something.
    void (async () => {
      while (!firstFrameAt && !reported && performance.now() - connectedAt < timeoutMs) {
        last = (await inboundVideo(pc)) ?? last;
        if (Number(last?.framesDecoded) > 0) firstFrameAt = performance.now();
        else await new Promise((r) => setTimeout(r, 30));
      }
    })();
    // A relay whose camera stops can keep the connection up with no frames in it, and the
    // last frame then stands in for the camera's view: count what arrives instead.
    let frames = -1;
    let framesAt = performance.now();
    watch = window.setInterval(async () => {
      last = (await inboundVideo(pc)) ?? last;
      const received = Number(last?.framesReceived ?? 0);
      if (received !== frames) {
        frames = received;
        framesAt = performance.now();
      } else if (performance.now() - framesAt > STALL_MS) lose();
    }, 2000);
    return { media, close };
  } catch (e) {
    measure('failed', e instanceof Error ? e.message : String(e));
    close();
    throw e;
  }
}

/**
 * Plays an MJPEG URL (a saved camera relayed by the server) as a MediaStream,
 * by drawing it onto a canvas, so it stands in for any other camera. `onLost`
 * fires once if the picture stops after it started.
 */
export async function openMjpeg(
  url: string,
  onLost: () => void,
  timeoutMs = 15000,
  fps = 15,
): Promise<OpenedStream> {
  const img = new Image();
  const canvas = document.createElement('canvas');
  let timer = 0;
  let media: MediaStream | null = null;
  const close = () => {
    window.clearInterval(timer);
    img.onerror = null;
    // Dropping the source ends the request, and with it the server's ffmpeg.
    img.removeAttribute('src');
    media?.getTracks().forEach((t) => t.stop());
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      img.onerror = () => reject(new Error('The camera stream could not be opened.'));
      img.src = new URL(url, window.location.href).href;
      timer = window.setInterval(() => {
        if (img.naturalWidth) resolve();
        else if (Date.now() - started > timeoutMs)
          reject(new Error('The camera stream did not start in time.'));
      }, 100);
    });
    window.clearInterval(timer);
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    const draw = () => {
      if (img.naturalWidth !== canvas.width || img.naturalHeight !== canvas.height) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      context.drawImage(img, 0, 0);
    };
    draw();
    media = canvas.captureStream(fps);
    timer = window.setInterval(draw, 1000 / fps);
    img.onerror = () => {
      close();
      onLost();
    };
    return { media, close };
  } catch (e) {
    close();
    throw e;
  }
}

/**
 * A stream cut to a zoomed view, drawn onto a canvas like `openMjpeg`, so the
 * rest of the lab sees only that part, as if it were the camera's whole frame.
 * Each decoded frame is drawn as it arrives, so the cut keeps the camera's
 * frame rate; `fps` paces it only where a browser can't say when one arrives.
 * Closing it closes the stream it was cut from.
 */
export async function cropStream(
  opened: OpenedStream,
  crop: CameraCrop,
  fps = 15,
): Promise<OpenedStream> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = opened.media;
  const canvas = document.createElement('canvas');
  let timer = 0;
  let frameCallback = 0;
  let media: MediaStream | null = null;
  const close = () => {
    window.clearInterval(timer);
    if (frameCallback) video.cancelVideoFrameCallback(frameCallback);
    frameCallback = 0;
    document.removeEventListener('visibilitychange', resume);
    video.srcObject = null;
    media?.getTracks().forEach((t) => t.stop());
    opened.close();
  };
  // A browser pauses a video outside the page while the page is hidden, and doesn't
  // play it again: the cut would keep drawing that old frame as if it were live.
  const resume = () => {
    if (video.paused && document.visibilityState === 'visible') void video.play().catch(() => {});
  };
  try {
    await video.play();
    document.addEventListener('visibilitychange', resume);
    const context = canvas.getContext('2d')!;
    const draw = () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      // Even sides, as a camera's frames are; the size follows a phone turned on its side.
      const width = Math.max(2, Math.round((w * crop.w) / 2) * 2);
      const height = Math.max(2, Math.round((h * crop.h) / 2) * 2);
      if (canvas.width !== width || canvas.height !== height)
        Object.assign(canvas, { width, height });
      context.drawImage(video, w * crop.x, h * crop.y, w * crop.w, h * crop.h, 0, 0, width, height);
    };
    draw();
    if ('requestVideoFrameCallback' in video) {
      // No rate: the canvas's stream takes a frame whenever it is drawn.
      media = canvas.captureStream();
      let drawnAt = performance.now();
      const next = () => {
        draw();
        drawnAt = performance.now();
        frameCallback = video.requestVideoFrameCallback(next);
      };
      frameCallback = video.requestVideoFrameCallback(next);
      // A browser may hold back frame callbacks for a video outside the page: draw anyway.
      timer = window.setInterval(() => {
        resume();
        if (performance.now() - drawnAt > 2000 / fps) draw();
      }, 1000 / fps);
    } else {
      media = canvas.captureStream(fps);
      timer = window.setInterval(() => {
        resume();
        draw();
      }, 1000 / fps);
    }
    return { media, close };
  } catch (e) {
    close();
    throw e;
  }
}
