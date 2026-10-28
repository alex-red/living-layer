import { useCallback, useEffect, useRef, useState } from 'react';

export interface CameraInfo {
  width: number;
  height: number;
  frameRate: number | null;
  label: string;
}

/**
 * Owns one webcam stream. Permission is only requested by `start`, and every
 * track is stopped on `stop`, on unmount, and when a newer start supersedes an
 * older one that is still waiting on the permission prompt.
 */
export function useCamera() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const [state, setState] = useState<'off' | 'opening' | 'on'>('off');
  const [error, setError] = useState('');
  const [info, setInfo] = useState<CameraInfo>();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');

  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  const stop = useCallback(() => {
    generation.current++;
    release();
    setState('off');
    setInfo(undefined);
  }, []);

  const start = useCallback(
    async (nextDeviceId = '') => {
      const current = ++generation.current;
      release();
      setError('');
      setState('opening');
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            ...(nextDeviceId ? { deviceId: { exact: nextDeviceId } } : {}),
          },
          audio: false,
        });
        if (current !== generation.current) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = media;
        const track = media.getVideoTracks()[0];
        track?.addEventListener('ended', () => {
          if (current !== generation.current) return;
          stop();
          setError('The camera was disconnected or taken by another app.');
        });
        // Labels are only filled in once permission has been granted.
        const all = await navigator.mediaDevices.enumerateDevices();
        if (current !== generation.current) return;
        setDevices(all.filter((d) => d.kind === 'videoinput'));
        setDeviceId(track?.getSettings().deviceId ?? nextDeviceId);
        setState('on');
      } catch {
        if (current !== generation.current) return;
        release();
        setState('off');
        setError('Camera access is unavailable. Check the browser permission and try again.');
      }
    },
    [stop],
  );

  useEffect(() => {
    const el = video.current;
    if (state !== 'on' || !el || !stream.current) return;
    el.srcObject = stream.current;
    const read = () => {
      const settings = stream.current?.getVideoTracks()[0]?.getSettings();
      setInfo({
        width: el.videoWidth,
        height: el.videoHeight,
        frameRate: settings?.frameRate ? Math.round(settings.frameRate) : null,
        label: stream.current?.getVideoTracks()[0]?.label ?? '',
      });
    };
    el.addEventListener('loadedmetadata', read);
    el.addEventListener('resize', read);
    void el.play().catch(() => setError('Camera playback failed. Stop the camera and try again.'));
    return () => {
      el.removeEventListener('loadedmetadata', read);
      el.removeEventListener('resize', read);
    };
  }, [state]);

  useEffect(
    () => () => {
      generation.current++;
      release();
    },
    [],
  );

  return { video, state, error, info, devices, deviceId, start, stop };
}
