import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** A camera shared on the LAN with `scripts/share-camera.sh`, as `/api/streams` lists it. */
export interface NetworkStream {
  id: string;
  name: string;
  host: string;
  whep: string;
  rtsp?: string;
  source: 'mdns' | 'config';
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
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setStreams((await api<{ streams: NetworkStream[] }>('streams')).streams);
    } catch {
      setStreams([]);
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => void scan(), [scan]);
  return { streams, scanning, scan };
}

/**
 * Plays a WHEP endpoint as a receive-only WebRTC stream. The offer goes out once
 * ICE gathering is done (instant on a LAN), so no trickle PATCHes are needed.
 * `onLost` fires once if the connection drops after it was up.
 */
export async function openStream(
  whep: string,
  onLost: () => void,
  timeoutMs = 8000,
): Promise<OpenedStream> {
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
