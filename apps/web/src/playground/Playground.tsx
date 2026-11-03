import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { EvidenceRun, LabStatus, Scene, Segmentation, ZoneRect } from '@livinglayer/domain';
import { footInZone, runCost } from '@livinglayer/domain';
import { api } from '../api';
import { usd } from '../cost';
import { Glyph } from '../Glyph';
import { sendToLab } from '../handoff';
import { MaskOverlay } from '../MaskOverlay';
import { PhonePairing } from '../PhonePairing';
import { PixelFeed, type PixelPalette } from './PixelFeed';
import { networkSource, useCamera } from './useCamera';
import { useNetworkStreams } from '../streams';
import { Button, Check, Field, Select, type Option } from '../ui/controls';
import { useMotionGate, type Stillness } from './useMotionGate';
import './playground.css';

interface Shot {
  id: number;
  url: string;
  width: number;
  height: number;
  motion: number;
  state: Stillness;
  takenAt: Date;
  /** Where the frame came from. A file has no motion reading. */
  source: 'camera' | 'file';
  scene?: Scene;
  segmentation?: Segmentation;
  /** Estimated spend on live calls for this frame, in USD. */
  spent?: number;
}
/** A mask SAM returned for the live view while watching. */
interface Sighting {
  segmentation: Segmentation;
  takenAt: Date;
  ms: number;
  cost: number;
  /** The desk moved after this frame was grabbed, so the mask may no longer line up. */
  stale: boolean;
}
type Point = { x: number; y: number };
type Tone = 'idle' | 'seen' | 'ok' | 'unsure' | 'blocked';

const UNIT = { width: 1, height: 1 };
/** The shortest gap between two automatic calls, however often the desk settles. */
const WATCH_GAP_MS = 3000;
const PALETTE_OPTIONS: Option<PixelPalette>[] = [
  { value: 'neon', label: 'Quiet Neon' },
  { value: 'mono', label: 'Mono, 4 tones' },
  { value: 'full', label: 'Full colour, posterized' },
];
const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const pct = (n: number) => `${Math.round(n * 100)}%`;
const time = (d: Date) =>
  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Brackets() {
  return (
    <>
      <span className="pg-tick tl" />
      <span className="pg-tick tr" />
      <span className="pg-tick bl" />
      <span className="pg-tick br" />
    </>
  );
}

export function Playground() {
  const camera = useCamera();
  const network = useNetworkStreams();
  /** A source value from the picker: a network camera, or a local device id. */
  const source = (value: string) =>
    network.streams.find((s) => networkSource(s) === value) ??
    (value.startsWith('net:') ? '' : value);
  const [pairPhone, setPairPhone] = useState(false);
  const [mirror, setMirror] = useState(true);
  const [guides, setGuides] = useState(true);
  const [pixelArt, setPixelArt] = useState(false);
  const [blockPx, setBlockPx] = useState(8);
  const [palette, setPalette] = useState<PixelPalette>('neon');
  const [dither, setDither] = useState(true);
  const [threshold, setThreshold] = useState(1.5);
  const [settleMs, setSettleMs] = useState(800);
  const [showCells, setShowCells] = useState(false);
  const [autoCapture, setAutoCapture] = useState(false);
  const [shot, setShot] = useState<Shot>();
  const [kept, setKept] = useState<Shot[]>([]);
  const [flash, setFlash] = useState(0);
  const [zone, setZone] = useState<ZoneRect>();
  const [drawing, setDrawing] = useState(false);
  const [testBox, setTestBox] = useState(true);
  const [box, setBox] = useState<ZoneRect>({ x: 0.42, y: 0.4, width: 0.16, height: 0.22 });
  const drag = useRef<
    { kind: 'draw'; start: Point } | { kind: 'move'; dx: number; dy: number } | null
  >(null);
  const shotId = useRef(0);
  const [meta, setMeta] = useState<LabStatus['meta']>();
  const [concept, setConcept] = useState('mug');
  const [watch, setWatch] = useState(false);
  const [sighting, setSighting] = useState<Sighting>();
  const [watchBusy, setWatchBusy] = useState(false);
  const [detecting, setDetecting] = useState<'' | 'discover' | 'segment'>('');
  const [detectError, setDetectError] = useState('');
  const detectRun = useRef(0);

  const live = camera.state === 'on';
  const reviewing = Boolean(shot);
  const motion = useMotionGate(camera.video, live && !reviewing, { threshold, settleMs });
  const flip = mirror && !reviewing;

  useEffect(() => {
    const previous = document.title;
    document.title = 'Camera playground · Living Layer';
    return () => {
      document.title = previous;
    };
  }, []);

  function loadStatus() {
    return api<LabStatus>('status')
      .then((s) => setMeta(s.meta))
      .catch(() => setDetectError('The local server is unreachable, so detection is off.'));
  }
  useEffect(() => {
    void loadStatus();
  }, []);
  const canDetect = Boolean(meta?.configured && meta.enabled);
  const budgetLeft = meta ? Math.max(0, meta.spendLimit - meta.spentToday) : 0;

  /**
   * The slow half of the two-speed design: send one captured frame to the
   * local server, which asks Muse Spark to name objects and SAM to mask the
   * chosen concept. Passing a concept skips discovery and only re-segments.
   */
  async function detect(target: Shot, only?: string) {
    const run = ++detectRun.current;
    const patch = (fields: Partial<Shot>) =>
      setShot((s) => (s?.id === target.id ? { ...s, ...fields } : s));
    let spent = target.spent ?? 0;
    setDetectError('');
    try {
      if (!only) {
        setDetecting('discover');
        const found = await api<EvidenceRun<Scene>>('discover', {
          mode: 'live',
          imageDataUrl: target.url,
        });
        spent += runCost(found) ?? 0;
        if (run !== detectRun.current) return;
        patch({ scene: found.output, spent });
      }
      setDetecting('segment');
      const masked = await api<EvidenceRun<Segmentation>>('segment', {
        mode: 'live',
        imageDataUrl: target.url,
        concept: only ?? concept.trim(),
      });
      spent += runCost(masked) ?? 0;
      if (run !== detectRun.current) return;
      patch({ segmentation: masked.output, spent });
      if (masked.status === 'no_match')
        setDetectError(`No ${masked.output.concept} in this frame.`);
    } catch (e) {
      if (run === detectRun.current)
        setDetectError(e instanceof Error ? e.message : 'Detection failed.');
    } finally {
      if (run === detectRun.current) setDetecting('');
      void loadStatus();
    }
  }
  function leaveReview() {
    detectRun.current++;
    setDetecting('');
    setDetectError('');
    setShot(undefined);
  }

  /** Draw the current video frame, at most 1280 px on its long side, as a JPEG. */
  function grabFrame() {
    const el = camera.video.current;
    if (!el?.videoWidth) return;
    const scale = Math.min(1, 1280 / Math.max(el.videoWidth, el.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(el.videoWidth * scale);
    canvas.height = Math.round(el.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) return;
    // The preview may be mirrored. The captured frame never is.
    context.drawImage(el, 0, 0, canvas.width, canvas.height);
    return { url: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height };
  }

  function capture() {
    const frame = grabFrame();
    if (!frame) return;
    // A fresh mask from watching belongs to this same still scene, so keep it.
    const carried = sighting && !sighting.stale ? sighting : undefined;
    const next: Shot = {
      id: ++shotId.current,
      ...frame,
      segmentation: carried?.segmentation,
      spent: carried?.cost,
      motion: motion.score,
      state: motion.state,
      takenAt: new Date(),
      source: 'camera',
    };
    setShot(next);
    setFlash((n) => n + 1);
  }

  /** A saved desk photo stands in for the camera, so detection and zones work without one. */
  const file = useRef<HTMLInputElement>(null);
  async function openFile(chosen?: File) {
    if (file.current) file.current.value = '';
    if (!chosen) return;
    try {
      if (!['image/png', 'image/jpeg'].includes(chosen.type) || chosen.size > 10_000_000)
        throw new Error('Choose a PNG or JPEG under 10 MB.');
      const bitmap = await createImageBitmap(chosen, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      detectRun.current++;
      setDetecting('');
      setDetectError('');
      setShot({
        id: ++shotId.current,
        url: canvas.toDataURL('image/jpeg', 0.9),
        width: canvas.width,
        height: canvas.height,
        motion: 0,
        state: 'still',
        takenAt: new Date(),
        source: 'file',
      });
    } catch (e) {
      setDetectError(e instanceof Error ? e.message : 'Could not open that image.');
    }
  }
  function reopen(k: Shot) {
    detectRun.current++;
    setDetecting('');
    setDetectError('');
    setDrawing(false);
    setShot(k);
  }
  function openInLab(k: Shot) {
    if (!sendToLab(k.url))
      setDetectError(
        'This browser blocked session storage, so the frame cannot move to the workspace.',
      );
  }

  /**
   * Watching: each time the desk settles after moving, grab the frame and ask
   * SAM for the concept. Spark is skipped here to keep each settle to one
   * cheap call. Any failure, including the daily spending limit being reached, stops
   * watching rather than retrying.
   */
  const motionEpoch = useRef(0);
  const lastWatch = useRef(0);
  async function watchDetect() {
    const frame = grabFrame();
    if (!frame) return;
    const epoch = motionEpoch.current;
    lastWatch.current = performance.now();
    setWatchBusy(true);
    setDetectError('');
    try {
      const run = await api<EvidenceRun<Segmentation>>('segment', {
        mode: 'live',
        imageDataUrl: frame.url,
        concept: concept.trim(),
      });
      setSighting({
        segmentation: run.output,
        takenAt: new Date(),
        ms: run.durationMs,
        cost: runCost(run) ?? 0,
        stale: epoch !== motionEpoch.current,
      });
    } catch (e) {
      setWatch(false);
      setDetectError(
        `${e instanceof Error ? e.message : 'Detection failed.'} Watching has stopped.`,
      );
    } finally {
      setWatchBusy(false);
      void loadStatus();
    }
  }
  useEffect(() => {
    if (!live) {
      setWatch(false);
      setSighting(undefined);
    }
  }, [live]);

  // Auto-capture fires once each time the scene comes to rest after moving.
  // Watching does the same, and also fires once on the first still frame.
  const sawMotion = useRef(false);
  const watchDue = useRef(true);
  const lastState = useRef<Stillness>('settling');
  // It runs after every render on purpose: the refs above decide when a capture is due.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (motion.state === 'moving') {
      sawMotion.current = true;
      watchDue.current = true;
      if (lastState.current !== 'moving') {
        motionEpoch.current++;
        setSighting((s) => (s && !s.stale ? { ...s, stale: true } : s));
      }
    }
    if (
      watch &&
      live &&
      !reviewing &&
      !watchBusy &&
      watchDue.current &&
      motion.state === 'still' &&
      performance.now() - lastWatch.current > WATCH_GAP_MS
    ) {
      watchDue.current = false;
      void watchDetect();
    }
    if (
      autoCapture &&
      live &&
      !reviewing &&
      sawMotion.current &&
      motion.state === 'still' &&
      lastState.current !== 'still'
    ) {
      sawMotion.current = false;
      capture();
    }
    lastState.current = motion.state;
  });

  function keep() {
    if (!shot) return;
    setKept((list) => [shot, ...list.filter((k) => k.id !== shot.id)].slice(0, 6));
    leaveReview();
  }

  function point(e: PointerEvent<HTMLElement>): Point {
    const stage = e.currentTarget.closest('.pg-stage')!.getBoundingClientRect();
    const x = clamp((e.clientX - stage.left) / stage.width);
    return { x: flip ? 1 - x : x, y: clamp((e.clientY - stage.top) / stage.height) };
  }
  const place = (r: ZoneRect): CSSProperties => ({
    left: `${(flip ? 1 - r.x - r.width : r.x) * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.width * 100}%`,
    height: `${r.height * 100}%`,
  });
  function startDrawing() {
    setZone((z) => z ?? { x: 0.3, y: 0.3, width: 0.4, height: 0.45 });
    setDrawing(true);
  }
  function nudge(dx: number, dy: number) {
    setBox((b) => ({
      ...b,
      x: clamp(b.x + dx, 0, 1 - b.width),
      y: clamp(b.y + dy, 0, 1 - b.height),
    }));
  }

  // A real detection wins over the test box: the frozen frame's while
  // reviewing, otherwise the latest watch result if the desk hasn't moved since.
  // The rule checks the most confident one, like the lab does.
  const liveMasks = live && !reviewing && sighting && !sighting.stale ? sighting : undefined;
  const masks = reviewing ? shot?.segmentation : liveMasks?.segmentation;
  const best = masks?.detections.reduce<(typeof masks.detections)[number] | undefined>(
    (top, d) => (!top || (d.confidence ?? 0) > (top.confidence ?? 0) ? d : top),
    undefined,
  );
  // While watching, only a real mask counts: the test box would hide a miss.
  const watchingLive = watch && live && !reviewing;
  const showTestBox = testBox && (live || shot) && !best && !watchingLive;
  const subject = best
    ? { box: best.box, frame: masks!.frame, name: `${masks!.concept} #${best.objectId}` }
    : showTestBox
      ? { box, frame: UNIT, name: 'The test box' }
      : undefined;
  const wait = (text: string) => ({ tone: 'unsure' as const, glyph: '◌', text });
  const verdict: { tone: Tone; glyph: string; text: string } = !zone
    ? { tone: 'idle', glyph: '○', text: 'Draw a zone to try the placement rule.' }
    : live && !reviewing && motion.state !== 'still'
      ? wait('Waiting for the scene to settle. The rule only runs on a still frame.')
      : !subject
        ? watchingLive
          ? watchBusy || !liveMasks
            ? wait(`Looking for the ${concept.trim()}…`)
            : {
                tone: 'idle',
                glyph: '×',
                text: `No ${liveMasks.segmentation.concept} in view. No lamp action.`,
              }
          : {
              tone: 'idle',
              glyph: '○',
              text: 'Watch the desk or detect on a captured frame, or turn on the test box.',
            }
        : footInZone(subject.box, subject.frame, zone)
          ? {
              tone: 'ok',
              glyph: '✓',
              text: `${subject.name} is inside. In the workspace, this would turn on the lamp.`,
            }
          : {
              tone: 'idle',
              glyph: '×',
              text: `${subject.name} is outside, or crossing the edge. No lamp action.`,
            };

  const status: { tone: Tone; text: string } = camera.error
    ? { tone: 'blocked', text: camera.error }
    : camera.state === 'opening'
      ? { tone: 'seen', text: 'Waiting for camera permission' }
      : watchBusy && !reviewing
        ? { tone: 'seen', text: `Looking for the ${concept.trim()}…` }
        : detecting
          ? {
              tone: 'seen',
              text:
                detecting === 'discover' ? 'Naming objects in the frame…' : 'Masking the object…',
            }
          : reviewing
            ? { tone: 'seen', text: 'Frame captured · keep it or retake' }
            : !live
              ? { tone: 'idle', text: 'Camera off' }
              : motion.state === 'moving'
                ? { tone: 'unsure', text: 'Motion detected' }
                : motion.state === 'settling'
                  ? { tone: 'unsure', text: 'Settling…' }
                  : liveMasks
                    ? {
                        tone: 'seen',
                        text: liveMasks.segmentation.detections.length
                          ? `Watching · ${liveMasks.segmentation.detections.length} ${liveMasks.segmentation.concept} in view`
                          : `Watching · no ${liveMasks.segmentation.concept} in view`,
                      }
                    : { tone: 'ok', text: 'Scene still · ready to capture' };

  const aspect = shot
    ? `${shot.width} / ${shot.height}`
    : camera.info?.width
      ? `${camera.info.width} / ${camera.info.height}`
      : '16 / 9';
  const aspectNumber = shot
    ? shot.width / shot.height
    : camera.info?.width && camera.info.height
      ? camera.info.width / camera.info.height
      : 16 / 9;
  const peak = Math.max(threshold * 3, ...motion.history);
  const spark = motion.history.map((s, i) => `${(i / 89) * 180},${36 - (s / peak) * 34}`).join(' ');

  return (
    <div className="pg">
      <header className="pg-top">
        <a className="pg-brand" href="/">
          <Glyph /> Living Layer <span className="pg-hud">CAMERA PLAYGROUND</span>
        </a>
        <div className={`pg-capsule ${status.tone}`} role="status" aria-live="polite">
          {live && <span className="pg-privacy" aria-label="Camera on" />}
          <span className={`pg-dot ${status.tone}`} />
          {status.text}
        </div>
        <a className="pg-back" href="/">
          Workspace <Glyph type="arrow" />
        </a>
      </header>

      <main className="pg-main">
        <aside className="pg-panel pg-left" aria-label="Camera and motion">
          <section className={`pg-card ${live ? 'current' : ''}`}>
            <div className="pg-card-title">
              <span className="pg-step">01</span>
              <h2>Camera</h2>
              {live && <span className="pg-hud ok">● ON</span>}
            </div>
            <p>Point it straight down at the desk and keep it still. The zone depends on it.</p>
            {live ? (
              <Button onClick={camera.stop}>Stop camera</Button>
            ) : (
              <Button
                variant="primary"
                disabled={camera.state === 'opening'}
                onClick={() => void camera.start(source(camera.deviceId))}
              >
                <Glyph type="camera" /> {camera.state === 'opening' ? 'Opening…' : 'Start camera'}
              </Button>
            )}
            {(camera.devices.length > 1 || network.streams.length > 0) && (
              <Field label="Device">
                <select
                  value={camera.deviceId}
                  disabled={camera.state === 'opening'}
                  onChange={(e) => void camera.start(source(e.target.value))}
                >
                  {camera.devices.length ? (
                    camera.devices.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${i + 1}`}
                      </option>
                    ))
                  ) : (
                    <option value="">This device's camera</option>
                  )}
                  {network.streams.length > 0 && (
                    <optgroup label="Network">
                      {network.streams.map((s) => (
                        <option key={s.id} value={networkSource(s)}>
                          {s.name} · {s.host}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </Field>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={network.scanning}
              onClick={() => void network.scan()}
            >
              {network.scanning ? 'Looking for network cameras…' : 'Find network cameras'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={pairPhone}
              onClick={() => setPairPhone((v) => !v)}
            >
              {pairPhone ? 'Hide phone pairing' : 'Use a phone as the camera'}
            </Button>
            {pairPhone && (
              <PhonePairing
                onUse={(phone) => {
                  setPairPhone(false);
                  void network.scan();
                  void camera.start(phone);
                }}
              />
            )}
            {camera.info?.label && <p className="pg-mono">{camera.info.label}</p>}
            <Check checked={pixelArt} onChange={setPixelArt}>
              Pixel-art preview
            </Check>
            {pixelArt && (
              <>
                <Field
                  className="pg-field"
                  label={
                    <>
                      Pixel size <b>{blockPx} px</b>
                    </>
                  }
                >
                  <input
                    type="range"
                    min="2"
                    max="32"
                    step="1"
                    value={blockPx}
                    onChange={(e) => setBlockPx(Number(e.target.value))}
                  />
                </Field>
                <Field label="Palette">
                  <Select<PixelPalette>
                    value={palette}
                    options={PALETTE_OPTIONS}
                    onChange={setPalette}
                  />
                </Field>
                <Check checked={dither} onChange={setDither}>
                  Ordered dithering
                </Check>
                <p>Preview only. Captures and the motion gate still use the clean feed.</p>
              </>
            )}
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={(e) => void openFile(e.target.files?.[0])}
            />
            <Button variant="ghost" size="sm" onClick={() => file.current?.click()}>
              <Glyph type="upload" /> Open a desk photo instead
            </Button>
          </section>

          <section className={`pg-card ${live && !reviewing ? 'current' : ''}`}>
            <div className="pg-card-title">
              <span className="pg-step">02</span>
              <h2>Motion gate</h2>
              <span className={`pg-hud ${motion.state === 'still' ? 'ok' : 'unsure'}`}>
                {live && !reviewing ? motion.state.toUpperCase() : 'IDLE'}
              </span>
            </div>
            <p>Runs on this device. Models only see a frame once the desk has been still.</p>
            <div className="pg-meter" aria-hidden="true">
              <span
                className={motion.state}
                style={{ width: `${Math.min(100, (motion.score / peak) * 100)}%` }}
              />
              <i style={{ left: `${(threshold / peak) * 100}%` }} />
            </div>
            <svg
              className="pg-spark"
              viewBox="0 0 180 36"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <line
                x1="0"
                x2="180"
                y1={36 - (threshold / peak) * 34}
                y2={36 - (threshold / peak) * 34}
              />
              {motion.history.length > 1 && <polyline points={spark} />}
            </svg>
            <Field
              className="pg-field"
              label={
                <>
                  Threshold <b>{threshold.toFixed(1)}% of pixels</b>
                </>
              }
            >
              <input
                type="range"
                min="0.2"
                max="10"
                step="0.1"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </Field>
            <Field
              className="pg-field"
              label={
                <>
                  Settle time <b>{settleMs} ms</b>
                </>
              }
            >
              <input
                type="range"
                min="200"
                max="3000"
                step="100"
                value={settleMs}
                onChange={(e) => setSettleMs(Number(e.target.value))}
              />
            </Field>
            <Check checked={showCells} onChange={setShowCells}>
              Show where it sees motion
            </Check>
            <Check checked={autoCapture} onChange={setAutoCapture}>
              Capture automatically when the desk settles
            </Check>
          </section>
        </aside>
        <section className="pg-scene" aria-label="Camera viewfinder">
          <div className="pg-fit">
            <div
              className={`pg-stage ${drawing ? 'drawing' : ''}`}
              style={{ aspectRatio: aspect, '--ar': aspectNumber } as CSSProperties}
              onPointerDown={(e) => {
                if (!drawing) return;
                const p = point(e);
                drag.current = { kind: 'draw', start: p };
                setZone({ ...p, width: 0, height: 0 });
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d) return;
                const p = point(e);
                if (d.kind === 'draw')
                  setZone({
                    x: Math.min(d.start.x, p.x),
                    y: Math.min(d.start.y, p.y),
                    width: Math.abs(d.start.x - p.x),
                    height: Math.abs(d.start.y - p.y),
                  });
                else
                  setBox((b) => ({
                    ...b,
                    x: clamp(p.x - d.dx, 0, 1 - b.width),
                    y: clamp(p.y - d.dy, 0, 1 - b.height),
                  }));
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
            >
              <div className={`pg-media ${flip ? 'mirrored' : ''}`}>
                <video
                  ref={camera.video}
                  muted
                  playsInline
                  hidden={!live || reviewing}
                  aria-label="Live camera preview"
                />
                <PixelFeed
                  video={camera.video}
                  active={pixelArt && live && !reviewing}
                  blockPx={blockPx}
                  palette={palette}
                  dither={dither}
                />
                {shot && <img src={shot.url} alt="Captured frame" />}
                {shot?.segmentation && (
                  <MaskOverlay key={shot.id} segmentation={shot.segmentation} cover />
                )}
                {showCells && live && !reviewing && motion.columns > 0 && (
                  <div
                    className="pg-cells"
                    aria-hidden="true"
                    style={{
                      gridTemplateColumns: `repeat(${motion.columns}, 1fr)`,
                      gridTemplateRows: `repeat(${motion.rows}, 1fr)`,
                    }}
                  >
                    {motion.cells.map((on, i) => (
                      <span key={i} className={on ? 'on' : ''} />
                    ))}
                  </div>
                )}
              </div>
              {live && !reviewing && sighting && (
                <MaskOverlay
                  key={sighting.takenAt.getTime()}
                  segmentation={sighting.segmentation}
                  mirror={flip}
                  cover
                  stale={sighting.stale}
                />
              )}

              {!live && !shot && (
                <div className="pg-empty">
                  <Glyph type="camera" />
                  <p>
                    {camera.state === 'opening'
                      ? 'Allow camera access in your browser.'
                      : 'Start the camera to try the viewfinder.'}
                  </p>
                  <small>Frames stay in this tab unless you ask to detect objects.</small>
                  <Button variant="ghost" onClick={() => file.current?.click()}>
                    <Glyph type="upload" /> Or open a desk photo
                  </Button>
                </div>
              )}

              {guides && (live || shot) && (
                <div className="pg-guides" aria-hidden="true">
                  <span className="v1" />
                  <span className="v2" />
                  <span className="h1" />
                  <span className="h2" />
                  <span className="reticle" />
                </div>
              )}

              {zone && (
                <div
                  className={`pg-zone ${drawing ? 'drawing' : ''}`}
                  style={place(zone)}
                  aria-label="Placement zone"
                >
                  <span className="pg-tag chosen">ZN-01</span>
                  {drawing && (
                    <span className="pg-size">
                      {pct(zone.width)} × {pct(zone.height)}
                    </span>
                  )}
                </div>
              )}

              {showTestBox && (
                <div
                  className={`pg-box ${!drawing ? 'movable' : ''}`}
                  style={place(box)}
                  role="slider"
                  tabIndex={drawing ? -1 : 0}
                  aria-label="Test box. Use the arrow keys to move it."
                  aria-valuetext={`${pct(box.x)} from left, ${pct(box.y)} from top`}
                  onPointerDown={(e) => {
                    if (drawing) return;
                    e.stopPropagation();
                    const p = point(e);
                    drag.current = { kind: 'move', dx: p.x - box.x, dy: p.y - box.y };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onKeyDown={(e) => {
                    const step = e.shiftKey ? 0.05 : 0.01;
                    const moves: Record<string, [number, number]> = {
                      ArrowLeft: [flip ? step : -step, 0],
                      ArrowRight: [flip ? -step : step, 0],
                      ArrowUp: [0, -step],
                      ArrowDown: [0, step],
                    };
                    const m = moves[e.key];
                    if (!m) return;
                    e.preventDefault();
                    nudge(...m);
                  }}
                >
                  <Brackets />
                  <span className="pg-tag seen">TEST BOX · SIM</span>
                </div>
              )}

              <Brackets />
              <span className="pg-hud pg-corner tl">
                {camera.info?.width
                  ? `CAM-01 · ${camera.info.width}×${camera.info.height}${camera.info.frameRate ? ` · ${camera.info.frameRate} FPS` : ''}`
                  : 'CAM-01 · NO SIGNAL'}
              </span>
              <span className="pg-hud pg-corner tr">
                {reviewing ? 'FROZEN' : !live ? '' : flip ? 'MIRRORED' : 'TRUE VIEW'}
              </span>
              {live && !reviewing && (
                <span className="pg-hud pg-corner bl">
                  MOT {motion.score.toFixed(1)}% · STILL {(motion.stillFor / 1000).toFixed(1)}s
                </span>
              )}
              {flash > 0 && <span key={flash} className="pg-flash" aria-hidden="true" />}

              {shot && (
                <div className="pg-review">
                  <p>
                    {shot.source === 'file' ? (
                      <>
                        <span className="ok">✓</span> Opened from a file · {shot.width}×
                        {shot.height}
                      </>
                    ) : shot.state === 'still' ? (
                      <>
                        <span className="ok">✓</span> Captured while still · motion{' '}
                        {shot.motion.toFixed(1)}%
                      </>
                    ) : (
                      <>
                        <span className="unsure">◌</span> Captured before the scene settled. Masks
                        may blur.
                      </>
                    )}
                  </p>
                  <div>
                    <Button variant="ghost" onClick={() => openInLab(shot)}>
                      Open in workspace
                    </Button>
                    <Button onClick={leaveReview}>
                      {shot.source === 'file' || kept.some((k) => k.id === shot.id)
                        ? 'Close'
                        : 'Retake'}
                    </Button>
                    <Button variant="primary" onClick={keep}>
                      Keep frame
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="pg-shutter-bar">
            <Check checked={mirror} onChange={setMirror}>
              Mirror preview
            </Check>
            <button
              className={`pg-shutter ${motion.state}`}
              disabled={!live || reviewing}
              onClick={capture}
              aria-label="Capture frame"
            >
              <span />
            </button>
            <Check checked={guides} onChange={setGuides}>
              Guides
            </Check>
          </div>
          <section className="pg-strip" aria-label="Kept frames">
            <div className="pg-strip-head">
              <h2>Kept frames</h2>
              <span className="pg-hud">THIS TAB ONLY · {kept.length} / 6</span>
              {kept.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setKept([])}>
                  Clear
                </Button>
              )}
            </div>
            {kept.length ? (
              <ol>
                {kept.map((k) => (
                  <li key={k.id} className={shot?.id === k.id ? 'open' : ''}>
                    <button
                      className="pg-thumb"
                      onClick={() => reopen(k)}
                      aria-label={`Open kept frame ${k.id}`}
                    >
                      <img src={k.url} alt="" />
                    </button>
                    <span className="pg-mono">
                      #{String(k.id).padStart(2, '0')} · {time(k.takenAt)}
                      <br />
                      {k.width}×{k.height} · MOT {k.motion.toFixed(1)}%
                      {k.segmentation
                        ? ` · ${k.segmentation.detections.length} ${k.segmentation.concept}`
                        : ''}{' '}
                      <span className={k.state === 'still' ? 'ok' : 'unsure'}>
                        {k.source === 'file' ? 'FILE' : k.state === 'still' ? '✓' : '◌'}
                      </span>
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => openInLab(k)}>
                      Open in workspace
                    </Button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="pg-placeholder">
                Frames you keep show up here. Open one again to re-detect or test the zone, or send
                it to the workspace to run the full placement check. They're gone when you close the
                tab.
              </p>
            )}
          </section>
        </section>
        <aside className="pg-panel pg-right" aria-label="Detection and zone">
          <section className={`pg-card ${(reviewing || watch) && !drawing ? 'current' : ''}`}>
            <div className="pg-card-title">
              <span className="pg-step">03</span>
              <h2>Detect</h2>
              {best ? (
                <span className="pg-hud seen">
                  {masks!.detections.length} MASK{masks!.detections.length === 1 ? '' : 'S'}
                </span>
              ) : (
                <span className={`pg-hud ${canDetect ? 'ok' : 'unsure'}`}>
                  {!meta ? '…' : !canDetect ? 'OFF' : watch ? 'WATCHING' : 'LIVE'}
                </span>
              )}
            </div>
            <p>
              Frames go to the local server, which asks SAM 3.1 to mask the object and, on a
              captured frame, Muse Spark to name what else is there. Each call counts toward the
              daily spending limit.
            </p>
            {meta && !canDetect && <p className="pg-mono">{meta.note}</p>}
            <Field label="Object to mask">
              <input
                value={concept}
                maxLength={80}
                onChange={(e) => setConcept(e.target.value)}
                placeholder="mug"
              />
            </Field>
            <Check
              checked={watch}
              disabled={
                !canDetect ||
                !live ||
                !concept.trim() ||
                (!watch && budgetLeft < (meta?.estimates.segment.usd ?? 0))
              }
              onChange={(on) => {
                setWatch(on);
                watchDue.current = true;
                if (!on) setSighting(undefined);
              }}
            >
              Watch the desk: mask the {concept.trim() || 'object'} each time it settles
            </Check>
            {meta && canDetect && (
              <p className="pg-mono">
                {usd(meta.estimates.segment.usd)} per settle, at most one every{' '}
                {WATCH_GAP_MS / 1000} s · {usd(budgetLeft)} left of today’s limit
                {sighting && (
                  <>
                    <br />
                    Last look {time(sighting.takenAt)} · {sighting.segmentation.detections.length}{' '}
                    {sighting.segmentation.concept} · {(sighting.ms / 1000).toFixed(1)} s ·{' '}
                    {usd(sighting.cost)}
                    {sighting.stale && ' · moved since, waiting to settle'}
                  </>
                )}
              </p>
            )}
            <div className="pg-row">
              <Button
                variant="primary"
                disabled={!shot || !canDetect || Boolean(detecting) || !concept.trim()}
                onClick={() => shot && void detect(shot)}
              >
                {detecting ? 'Detecting…' : 'Detect on this frame'}
              </Button>
            </div>
            {meta && (
              <p className="pg-mono">
                ≈ {usd(meta.estimates.discover.usd + meta.estimates.segment.usd)} per detection ·
                Spark {usd(meta.estimates.discover.usd)}
                {meta.estimates.discover.basis === 'guess'
                  ? ' (rough guess until a live run)'
                  : ` (median of ${meta.estimates.discover.samples})`}{' '}
                + SAM {usd(meta.estimates.segment.usd)}
                <br />
                {shot?.spent ? `This frame ≈ ${usd(shot.spent)} · ` : ''}
                Today ≈ {usd(meta.spentToday)} of {usd(meta.spendLimit)} limit · {meta.usedToday}{' '}
                calls
              </p>
            )}
            {shot?.scene && shot.scene.objects.length > 0 && (
              <div className="pg-chips" role="group" aria-label="Objects Muse Spark named">
                {shot.scene.objects.map((o) => (
                  <button
                    key={o.label}
                    className={`pg-chip ${masks?.concept === o.category ? 'on' : ''}`}
                    disabled={Boolean(detecting)}
                    title={`${o.appearance} · re-mask for ${usd(meta?.estimates.segment.usd ?? 0)}`}
                    onClick={() => {
                      setConcept(o.category);
                      void detect(shot, o.category);
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            {detectError && (
              <p className="pg-verdict unsure" role="alert">
                <span>◌</span>
                {detectError}
              </p>
            )}
          </section>

          <section className={`pg-card ${drawing ? 'current chosen' : ''}`}>
            <div className="pg-card-title">
              <span className="pg-step">04</span>
              <h2>Zone</h2>
              {zone && <span className="pg-hud chosen">ZN-01</span>}
            </div>
            <p>
              Drag on the frame to draw. The zone is stored in frame coordinates, so moving the
              camera breaks it.
            </p>
            <div className="pg-row">
              {drawing ? (
                <Button onClick={() => setDrawing(false)}>Done</Button>
              ) : (
                <Button onClick={startDrawing}>{zone ? 'Redraw zone' : 'Draw zone'}</Button>
              )}
              {zone && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setZone(undefined);
                    setDrawing(false);
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
            {zone && (
              <p className="pg-mono">
                X {pct(zone.x)} · Y {pct(zone.y)} · W {pct(zone.width)} · H {pct(zone.height)}
              </p>
            )}
            <Check checked={testBox} onChange={setTestBox}>
              Test box (used until a frame has a real detection)
            </Check>
            <p className={`pg-verdict ${verdict.tone}`}>
              <span>{verdict.glyph}</span>
              {verdict.text}
            </p>
          </section>
        </aside>
      </main>
    </div>
  );
}
