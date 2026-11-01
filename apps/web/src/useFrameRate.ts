import { useEffect, useState, type RefObject } from 'react';

/**
 * Frames a second a playing video shows, counted from the frames the browser
 * presents and updated once a second. Null while `on` is false, before the
 * first second, or where the browser can't say when a frame is shown.
 */
export function useFrameRate(video: RefObject<HTMLVideoElement | null>, on: boolean) {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    setFps(null);
    const v = video.current;
    if (!on || !v || !('requestVideoFrameCallback' in v)) return;
    let presented = 0;
    let handle = 0;
    const seen = (_now: number, frame: VideoFrameCallbackMetadata) => {
      presented = frame.presentedFrames;
      handle = v.requestVideoFrameCallback(seen);
    };
    handle = v.requestVideoFrameCallback(seen);
    let from = { at: performance.now(), presented };
    const timer = window.setInterval(() => {
      const at = performance.now();
      // The first count can start mid-stream: a frame callback reports all frames so far.
      if (from.presented)
        setFps(Math.round(((presented - from.presented) * 1000) / (at - from.at)));
      from = { at, presented };
    }, 1000);
    return () => {
      v.cancelVideoFrameCallback(handle);
      window.clearInterval(timer);
    };
  }, [video, on]);
  return fps;
}
