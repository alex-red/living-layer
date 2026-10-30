import { useCallback, useEffect, useState } from 'react';
import type { CameraScene } from '@livinglayer/domain';
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

/**
 * Plays a WHEP endpoint as a receive-only WebRTC stream. The offer goes out once
 * ICE gathering is done (instant on a LAN), so no trickle PATCHes are needed.
 * `onLost` fires once if the connection drops after it was up.
 */
export async function openStream(
  endpoint: string,
  onLost: () => void,
  timeoutMs = 8000,
): Promise<OpenedStream> {
  const whep = new URL(endpoint, window.location.href).href;
  const pc = new RTCPeerConnection();
  let session = '';
  const close = () => {
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
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(pc.connectionState)) onLost();
    });
    return { media, close };
  } catch (e) {
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
