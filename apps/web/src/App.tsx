import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type {
  EvidenceRun,
  LabStatus,
  Mode,
  Scene,
  Segmentation,
  LampResult,
  DeskMemory,
  ZoneRect,
  PlacementDecision,
} from '@livinglayer/domain';
import { OBSERVATION_MAX_AGE_MS, isMugConcept, runCost } from '@livinglayer/domain';
import { api } from './api';
import { estimateLabel, usd } from './cost';
import { Glyph } from './Glyph';
import { MaskOverlay } from './MaskOverlay';

const BUSY: Record<string, string> = {
  text: 'Checking the connection',
  discover: 'Discovering objects',
  segment: 'Finding the shape',
  lamp: 'Switching the lamp',
  select: 'Remembering the mug',
  zone: 'Saving the zone',
  verify: 'Checking placement',
  reset: 'Resetting desk memory',
};
const RESULT_GLYPH: Record<EvidenceRun['status'], string> = {
  completed: '✓',
  no_match: '◌',
  unconfirmed: '◌',
  failed: '×',
};

export function App() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [mode, setMode] = useState<Mode>('fixture');
  const [status, setStatus] = useState<LabStatus>();
  const [runs, setRuns] = useState<EvidenceRun[]>([]);
  const [image, setImage] = useState<string>();
  const [dimensions, setDimensions] = useState({ width: 960, height: 640 });
  const [scene, setScene] = useState<Scene>();
  const [segmentation, setSegmentation] = useState<Segmentation>();
  const [memories, setMemories] = useState<Partial<Record<Mode, DeskMemory>>>({});
  const memory = memories[mode];
  const [segmentRunId, setSegmentRunId] = useState<string>();
  const [draftZone, setDraftZone] = useState<ZoneRect>({ x: 0.3, y: 0.2, width: 0.4, height: 0.6 });
  const [drawing, setDrawing] = useState(false);
  const zoneStart = useRef<{ x: number; y: number } | null>(null);
  const [concept, setConcept] = useState('mug');
  const [overlay, setOverlay] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState(
    'Start with the illustrated desk. Every fixture result is labeled.',
  );
  const [selected, setSelected] = useState<EvidenceRun>();
  // Drives the ambient warm-up. Only a confirmed lamp state turns it on.
  const [lamp, setLamp] = useState<'off' | 'virtual' | 'live'>('off');
  const light = () => setLamp(mode === 'fixture' ? 'virtual' : 'live');
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const cameraGeneration = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const imageGeneration = useRef(0);
  const mounted = useRef(true);
  const refresh = async () => {
    const [nextStatus, nextRuns, fixtureDesk, liveDesk] = await Promise.all([
      api<LabStatus>('status'),
      api<EvidenceRun[]>('runs'),
      api<DeskMemory>('desk/fixture'),
      api<DeskMemory>('desk/live'),
    ]);
    setStatus(nextStatus);
    setRuns(nextRuns);
    setMemories({ fixture: fixtureDesk, live: liveDesk });
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() =>
      setError('The local API is unavailable. Start both services with bun run dev.'),
    );
    return () => {
      mounted.current = false;
      cameraGeneration.current++;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  const stopCamera = () => {
    cameraGeneration.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCamera(false);
  };
  function changeMode(next: Mode) {
    stopCamera();
    imageGeneration.current++;
    setMode(next);
    setLamp('off');
    setImage(undefined);
    setDimensions({ width: 960, height: 640 });
    setScene(undefined);
    setSegmentation(undefined);
    setSegmentRunId(undefined);
    setDrawing(false);
    setError('');
    setMessage(
      next === 'fixture'
        ? 'Illustrated fixture selected. No inference or physical action.'
        : 'Add a desk photo. It stays local until you explicitly run a live probe.',
    );
  }
  function captureCanvas(source: CanvasImageSource, width: number, height: number) {
    const scale = Math.min(1, 1280 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare the image.');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    setImage(canvas.toDataURL('image/png'));
    setDimensions({ width: canvas.width, height: canvas.height });
    setScene(undefined);
    setSegmentation(undefined);
    setSegmentRunId(undefined);
    setDrawing(false);
    setMessage(
      'Photo prepared locally. Live probes send this image to Meta only when you press a probe button.',
    );
  }
  async function upload(chosen?: File) {
    if (!chosen) return;
    const generation = ++imageGeneration.current;
    setError('');
    try {
      if (!['image/png', 'image/jpeg'].includes(chosen.type) || chosen.size > 10_000_000)
        throw new Error('Choose a PNG or JPEG under 10 MB.');
      const bitmap = await createImageBitmap(chosen, { imageOrientation: 'from-image' });
      try {
        if (mounted.current && generation === imageGeneration.current)
          captureCanvas(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that image.');
    }
    if (file.current) file.current.value = '';
  }
  async function startCamera() {
    if (cameraPending || stream.current) return;
    setError('');
    setCameraPending(true);
    const generation = ++cameraGeneration.current;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (!mounted.current || generation !== cameraGeneration.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      setCamera(true);
    } catch {
      if (mounted.current && generation === cameraGeneration.current)
        setError('Camera access is unavailable. Upload a desk photo instead.');
    } finally {
      if (mounted.current) setCameraPending(false);
    }
  }
  useEffect(() => {
    if (camera && video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current
        .play()
        .catch(() => setError('Camera playback failed. Stop the camera and try an upload.'));
    }
  }, [camera]);
  function costNote(run: EvidenceRun) {
    const cost = runCost(run);
    return cost === null ? '' : ` · ≈ ${usd(cost)}`;
  }
  async function execute(kind: 'text' | 'discover' | 'segment' | 'lamp', overrideConcept?: string) {
    setBusy(kind);
    setError('');
    try {
      const run = await api<EvidenceRun>(kind, {
        mode,
        ...(['discover', 'segment'].includes(kind) && image ? { imageDataUrl: image } : {}),
        ...(kind === 'segment' ? { concept: overrideConcept ?? concept } : {}),
      });
      if (kind === 'discover') setScene(run.output as Scene);
      if (kind === 'discover' || kind === 'segment') setLamp('off');
      if (kind === 'lamp' && (run.output as LampResult).stateConfirmed) light();
      if (kind === 'segment') {
        setSegmentation(run.output as Segmentation);
        setSegmentRunId(run.id);
        setDrawing(false);
      }
      setSelected(run);
      setMessage(
        kind === 'segment' && run.status === 'no_match'
          ? 'No match. The previous mask has been cleared.'
          : `${mode === 'fixture' ? 'Fixture' : 'Live'} ${kind} probe saved · ${run.durationMs} ms${costNote(run)}.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Probe failed.');
      if (kind === 'segment') setSegmentation(undefined);
      void refresh().catch(() => {});
    } finally {
      setBusy('');
    }
  }
  async function deskAction(path: 'select' | 'zone' | 'verify' | 'reset', fields: object = {}) {
    setBusy(path);
    setError('');
    try {
      const result = await api<DeskMemory | EvidenceRun<PlacementDecision>>(`desk/${path}`, {
        mode,
        ...fields,
      });
      if (path === 'verify') {
        const event = result as EvidenceRun<PlacementDecision>;
        setSelected(event);
        if (event.output.action === 'confirmed') light();
        setMessage(
          `${mode === 'fixture' ? 'Virtual' : 'Live'} placement: ${event.output.reason} Lamp: ${event.output.action}.${event.output.error ? ` ${event.output.error.message}` : ''}`,
        );
      } else {
        setMemories((current) => ({ ...current, [mode]: result as DeskMemory }));
        if (path === 'reset') setLamp('off');
        setMessage(
          path === 'select'
            ? 'Mug identity manually confirmed. Draw or edit its zone next.'
            : path === 'zone'
              ? 'Zone saved for this exact image. Review it before verifying placement.'
              : 'Desk memory reset. Evidence and action deduplication are retained.',
        );
        setDrawing(false);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Desk operation failed.');
    } finally {
      setBusy('');
    }
  }
  const currentObservation =
    memory?.observation &&
    segmentation?.sourceKey === memory.observation.sourceKey &&
    segmentRunId === memory.observation.segmentRunId
      ? memory.observation
      : null;
  const observationStale = memory?.observation
    ? now - Date.parse(memory.observation.observedAt) > OBSERVATION_MAX_AGE_MS
    : false;
  const visibleZone = drawing
    ? draftZone
    : currentObservation && memory?.zone && memory.zone.sourceKey === segmentation?.sourceKey
      ? memory.zone.rect
      : null;
  function zonePoint(e: PointerEvent<SVGSVGElement>) {
    const bounds = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height)),
    };
  }
  const metaReady = Boolean(
    status?.meta.configured &&
    status.meta.enabled &&
    status.meta.usedToday < status.meta.requestLimit,
  );
  const lampReady = Boolean(status?.lamp.configured && status.lamp.enabled);
  const canVision = !busy && (mode === 'fixture' || (metaReady && Boolean(image)));
  const proofCount = status ? Object.values(status.liveEvidence).filter(Boolean).length : 0;
  const confirmedId = currentObservation?.detectionId;
  const step = !scene && !segmentation ? 1 : !segmentation ? 2 : 3;
  const capsuleTone = error ? 'blocked' : busy ? 'busy' : lamp !== 'off' ? 'warm' : 'idle';
  return (
    <div className={`shell lamp-${lamp}`}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Living Layer home">
          <span className="brand-icon">
            <Glyph />
          </span>
          Living Layer<span className="wordmark-sub">DESK LAB</span>
          {mode === 'live' && <span className="live-tag">LIVE</span>}
        </a>
        <div className={`feedback ${capsuleTone}`} role="status" aria-live="polite">
          {camera && <span className="privacy-dot" aria-label="Camera on" />}
          <span className="dot" />
          <span className="feedback-text">{busy ? `${BUSY[busy] ?? 'Working'}…` : message}</span>
          {lamp === 'virtual' && <span className="hud-tag">VIRTUAL</span>}
        </div>
        <nav className="topbar-links">
          <a className="playground-link" href="/playground">
            Camera playground
          </a>
          <a className="export" href="/api/evidence" download>
            Export evidence <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">
              <span className="dot" /> EXPERIMENTAL
            </p>
            <h1>
              A little context.
              <br />
              <em>A living space.</em>
            </h1>
            <p className="lede">
              Find the objects. See the mask. Test one light.
              <br />
              Select a mug. Mark a zone. Verify one placement.
            </p>
          </div>
          <aside className="session-note">
            <span className="edition">LOCAL ONLY · LOOPBACK API</span>
            <span className="tiny">THE EXPERIMENT</span>
            <p>
              Can we turn a desk scene
              <br />
              into something actionable?
            </p>
            <span className="note-rule" />
            <span className="tiny">SPARK → SAM → HOME ASSISTANT</span>
            <span className="note-foot">Manual placement checks · one action per observation</span>
          </aside>
        </section>
        <div className="workspace-heading">
          <h2>
            01 <span>The observation desk</span>
          </h2>
          <div className="mode-switch" aria-label="Data source">
            {(['fixture', 'live'] as const).map((value) => (
              <button
                key={value}
                disabled={Boolean(busy) || camera || cameraPending}
                aria-pressed={mode === value}
                onClick={() => changeMode(value)}
              >
                {value === 'fixture' ? 'Fixture' : 'Live'}
              </button>
            ))}
          </div>
        </div>
        <div className="workspace">
          <section className="observation" aria-label="Scene and segmentation">
            <div className="scene-toolbar">
              <span>
                <span className={`dot ${mode === 'live' ? 'live' : ''}`} />
                {mode === 'fixture'
                  ? 'ILLUSTRATED FIXTURE'
                  : image
                    ? 'LOCAL DESK PHOTO'
                    : 'AWAITING DESK PHOTO'}
              </span>
              <label className="overlay-toggle">
                <input
                  type="checkbox"
                  checked={overlay}
                  onChange={(e) => setOverlay(e.target.checked)}
                />{' '}
                Mask overlay
              </label>
            </div>
            <div
              className="scene"
              style={{ aspectRatio: `${dimensions.width} / ${dimensions.height}` }}
            >
              {camera ? (
                <video ref={video} muted playsInline aria-label="Desk camera preview" />
              ) : mode === 'fixture' || image ? (
                <img
                  src={mode === 'fixture' ? '/desk.svg' : image}
                  alt={
                    mode === 'fixture'
                      ? 'Illustrated desk with a mug, book, and bottle; synthetic fixture'
                      : 'Your prepared desk photo'
                  }
                />
              ) : (
                <div className="empty-scene">
                  <Glyph type="camera" />
                  <h3>Your desk, in context.</h3>
                  <p>Upload a photo or capture a frame to begin.</p>
                  <small>Prepared locally · sent only on an explicit live probe</small>
                </div>
              )}
              {!camera && segmentation && overlay && (
                <MaskOverlay
                  key={segmentRunId}
                  segmentation={segmentation}
                  chosenId={confirmedId}
                />
              )}
              {!camera && currentObservation && visibleZone && (
                <svg
                  className={`zone-overlay ${drawing ? 'drawing' : ''}`}
                  viewBox="0 0 1000 1000"
                  preserveAspectRatio="none"
                  aria-label={drawing ? 'Draw placement zone' : 'Saved placement zone'}
                  onPointerDown={(e) => {
                    if (!drawing || busy) return;
                    zoneStart.current = zonePoint(e);
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!drawing || !zoneStart.current) return;
                    const p = zonePoint(e),
                      a = zoneStart.current;
                    setDraftZone({
                      x: Math.min(a.x, p.x),
                      y: Math.min(a.y, p.y),
                      width: Math.abs(a.x - p.x),
                      height: Math.abs(a.y - p.y),
                    });
                  }}
                  onPointerUp={() => {
                    zoneStart.current = null;
                  }}
                  onPointerCancel={() => {
                    zoneStart.current = null;
                  }}
                >
                  <rect
                    x={visibleZone.x * 1000}
                    y={visibleZone.y * 1000}
                    width={visibleZone.width * 1000}
                    height={visibleZone.height * 1000}
                  />
                </svg>
              )}
              {!camera && currentObservation && visibleZone && (
                <span
                  className={`zone-tag ${drawing ? 'drawing' : ''}`}
                  style={{ left: `${visibleZone.x * 100}%`, top: `${visibleZone.y * 100}%` }}
                  aria-hidden="true"
                >
                  ZN-01
                  {drawing &&
                    ` · ${Math.round(visibleZone.width * 100)}×${Math.round(visibleZone.height * 100)}%`}
                </span>
              )}
              <span className="frame-tick tl" aria-hidden="true" />
              <span className="frame-tick tr" aria-hidden="true" />
              <span className="frame-tick bl" aria-hidden="true" />
              <span className="frame-tick br" aria-hidden="true" />
              <span className="frame-label">
                {dimensions.width} × {dimensions.height} <span>FRAME 00</span>
              </span>
            </div>
            <div className="scene-bottom">
              <span>
                {mode === 'fixture'
                  ? 'Synthetic scene. No camera, inference, or physical action.'
                  : 'Your photo is sent to Meta for live vision probes.'}
              </span>
              {mode === 'live' && (
                <div className="capture-actions">
                  <input
                    ref={file}
                    type="file"
                    accept="image/png,image/jpeg"
                    hidden
                    onChange={(e) => void upload(e.target.files?.[0])}
                  />
                  {camera ? (
                    <>
                      <button
                        disabled={Boolean(busy)}
                        onClick={() => {
                          if (video.current?.videoWidth) {
                            captureCanvas(
                              video.current,
                              video.current.videoWidth,
                              video.current.videoHeight,
                            );
                            stopCamera();
                          }
                        }}
                      >
                        Capture frame
                      </button>
                      <button onClick={stopCamera}>Stop camera</button>
                    </>
                  ) : (
                    <>
                      <button disabled={Boolean(busy)} onClick={() => file.current?.click()}>
                        <Glyph type="upload" /> Upload
                      </button>
                      <button
                        disabled={Boolean(busy) || cameraPending}
                        onClick={() => void startCamera()}
                      >
                        <Glyph type="camera" /> {cameraPending ? 'Opening…' : 'Camera'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="observed">
              <div className="section-label">
                <span>DISCOVERED OBJECTS</span>
                <span>
                  {scene
                    ? `${scene.objects.length.toString().padStart(2, '0')} OBJECTS`
                    : 'AWAITING PROBE'}
                </span>
              </div>
              {scene ? (
                <>
                  <p className="scene-summary">{scene.summary}</p>
                  <div className="object-grid">
                    {scene.objects.map((object, i) => (
                      <button
                        key={i}
                        disabled={Boolean(busy)}
                        onClick={() => setConcept(object.category)}
                        className={`object-card ${concept === object.category ? 'chosen' : ''}`}
                      >
                        <span className="object-number">0{i + 1}</span>
                        <strong>{object.label}</strong>
                        <small>{object.appearance}</small>
                        <span className="object-category">
                          {object.category} <span>↗</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {!scene.objects.length && <p>No suitable objects were returned.</p>}
                </>
              ) : (
                <p className="placeholder">Run discovery to name up to three visible objects.</p>
              )}
            </div>
          </section>
          <aside className="controls">
            <div className="control-header">
              <span className="tiny">THE PROBE BENCH</span>
              <h2>One step at a time.</h2>
              <p>
                {mode === 'fixture'
                  ? 'Exercise the pipeline with known inputs.'
                  : 'Each button makes one explicit live operation.'}
              </p>
            </div>
            <div className={`probe ${step === 1 ? 'current' : ''}`}>
              <div className="probe-title">
                <span className="step">01</span>
                <h3>Discover the scene</h3>
                <span className="model-tag">SPARK</span>
              </div>
              <p>
                Grounded labels, a short description.
                <br />
                Three objects at most.
              </p>
              <button
                className="primary"
                disabled={!canVision || camera}
                onClick={() => void execute('discover')}
              >
                {busy === 'discover' ? 'Discovering…' : 'Discover objects'}
                <Glyph type="arrow" />
              </button>
              {mode === 'live' && status && (
                <p className="micro">{estimateLabel(status.meta.estimates.discover)}</p>
              )}
            </div>
            <div className={`probe ${step === 2 ? 'current' : ''}`}>
              <div className="probe-title">
                <span className="step">02</span>
                <h3>Find the shape</h3>
                <span className="model-tag">SAM 3.1</span>
              </div>
              <label className="input-label" htmlFor="concept">
                Object concept
              </label>
              <div className="concept-input">
                <input
                  id="concept"
                  value={concept}
                  maxLength={80}
                  onChange={(e) => setConcept(e.target.value)}
                />
                <span>TEXT PROMPT</span>
              </div>
              <button
                className="primary"
                disabled={!canVision || !concept.trim() || camera}
                onClick={() => void execute('segment')}
              >
                {busy === 'segment' ? 'Decoding…' : 'Segment object'}
                <Glyph type="arrow" />
              </button>
              <button
                className="text-button"
                disabled={!canVision || camera}
                onClick={() => void execute('segment', 'unicorn')}
              >
                Test absent target <span>↗</span>
              </button>
              {mode === 'live' && status && (
                <p className="micro">{estimateLabel(status.meta.estimates.segment, 'image')}</p>
              )}
              <p className="micro">
                {segmentation
                  ? `${segmentation.detections.length} mask(s) · official Meta parser · ${mode}`
                  : 'Crop-local mask → source-pixel overlay'}
              </p>
            </div>
            <div className={`probe placement-controls ${step === 3 ? 'current chosen' : ''}`}>
              <div className="probe-title">
                <span className="step">03</span>
                <h3>Remember & place</h3>
                <span className="model-tag">ZONE</span>
              </div>
              <p>
                Confirm a specific mug mask. Identity is manual; the whole box must fit inside the
                zone.
              </p>
              {segmentation?.detections.map((d) => (
                <button
                  key={d.objectId}
                  className="secondary"
                  disabled={Boolean(busy) || !segmentRunId || !isMugConcept(segmentation.concept)}
                  onClick={() =>
                    void deskAction('select', { segmentRunId, detectionId: d.objectId })
                  }
                >
                  Confirm mug mask #{d.objectId}
                </button>
              ))}
              {memory?.object && (
                <p className="micro">
                  {memory.object.label} · {memory.object.id.slice(0, 8)}
                  <br />
                  {memory.observation
                    ? `Last observed ${new Date(memory.observation.observedAt).toLocaleTimeString()} · manual identity`
                    : 'No observation'}
                  {observationStale && ' · STALE: segment a new frame.'}
                  {!currentObservation && ' · Segment and confirm the current frame to continue.'}
                </p>
              )}
              <button
                className="text-button"
                disabled={Boolean(busy) || !currentObservation || camera}
                onClick={() => {
                  setDraftZone(memory?.zone?.rect ?? { x: 0.3, y: 0.2, width: 0.4, height: 0.6 });
                  setDrawing(true);
                }}
              >
                Draw / edit zone ↗
              </button>
              {drawing && (
                <div className="zone-editor">
                  <p className="micro">
                    Drag a rectangle on the image, or enter percentages below.
                  </p>
                  <div className="zone-fields">
                    {(['x', 'y', 'width', 'height'] as const).map((key) => (
                      <label key={key}>
                        Zone {key} %
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={Math.round(draftZone[key] * 100)}
                          disabled={Boolean(busy)}
                          onChange={(e) =>
                            setDraftZone((z) => ({ ...z, [key]: Number(e.target.value) / 100 }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    className="secondary"
                    disabled={Boolean(busy) || !currentObservation}
                    onClick={() =>
                      void deskAction('zone', {
                        observationId: currentObservation?.id,
                        rect: draftZone,
                      })
                    }
                  >
                    Save zone
                  </button>
                </div>
              )}
              <p className="micro">
                {memory?.zone ? 'Zone saved for its source image.' : 'No saved zone.'} Observations
                expire after 5 minutes. A still photo does not prove the current physical scene.
              </p>
              <button
                className="physical"
                disabled={
                  Boolean(busy) ||
                  drawing ||
                  !currentObservation ||
                  !memory?.zone ||
                  (mode === 'live' && !lampReady)
                }
                onClick={() =>
                  void deskAction('verify', {
                    observationId: currentObservation?.id,
                    zoneId: memory?.zone?.id,
                  })
                }
              >
                {busy === 'verify'
                  ? 'Checking placement…'
                  : mode === 'fixture'
                    ? 'Verify placement · virtual lamp'
                    : 'Verify placement · turn on lamp'}
              </button>
              {memory?.lastDecision && (
                <p className="placement-result" role="note">
                  {memory.lastDecision.mode.toUpperCase()} · {memory.lastDecision.output.decision} ·
                  lamp {memory.lastDecision.output.action}
                  <br />
                  {memory.lastDecision.output.reason}
                  {memory.lastDecision.output.error && (
                    <>
                      <br />
                      {memory.lastDecision.output.error.message}
                    </>
                  )}
                  {memory.lastDecision.output.lamp && (
                    <>
                      <br />
                      {memory.lastDecision.output.lamp.explanation}
                    </>
                  )}
                </p>
              )}
              <button
                className="text-button destructive"
                disabled={Boolean(busy) || !memory?.object}
                onClick={() => void deskAction('reset')}
              >
                Reset desk memory
              </button>
            </div>
            <div className="probe">
              <div className="probe-title">
                <span className="step">04</span>
                <h3>Test one light</h3>
                <span className="model-tag">HA</span>
              </div>
              <p>
                {mode === 'fixture'
                  ? 'Virtual lamp only. No hardware action.'
                  : 'Turns on your configured lamp. Check the physical effect separately.'}
              </p>
              <button
                className="physical"
                disabled={Boolean(busy) || (mode === 'live' && !lampReady)}
                onClick={() => void execute('lamp')}
              >
                {busy === 'lamp'
                  ? 'Checking state…'
                  : mode === 'fixture'
                    ? 'Simulate lamp action'
                    : 'Turn on desk lamp'}
                <Glyph type="arrow" />
              </button>
            </div>
            <div className="connection">
              <span className="tiny">CONNECTION CHECK</span>
              <button
                className="text-button"
                disabled={Boolean(busy) || (mode === 'live' && !metaReady)}
                onClick={() => void execute('text')}
              >
                {busy === 'text' ? 'Checking…' : 'Run text smoke test'} <span>↗</span>
              </button>
              {mode === 'live' && status && (
                <p className="micro">{estimateLabel(status.meta.estimates.text)}</p>
              )}
            </div>
          </aside>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <section className="evidence-section">
          <div>
            <div className="workspace-heading">
              <h2>
                02 <span>The evidence notebook</span>
              </h2>
              <span className="tiny">LOCAL · PERSISTENT · EXPORTABLE</span>
            </div>
            <div className="evidence-table">
              <div className="table-head">
                <span>PROBE / SOURCE</span>
                <span>RESULT</span>
                <span>DURATION</span>
              </div>
              {runs.length ? (
                runs.slice(0, 8).map((run) => (
                  <button
                    className={`run-row ${selected?.id === run.id ? 'selected' : ''}`}
                    key={run.id}
                    onClick={() => setSelected(run)}
                  >
                    <span>
                      <strong>{run.kind}</strong>
                      <small>
                        {new Date(run.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        <b className={`badge ${run.mode}`}>{run.mode}</b>
                      </small>
                    </span>
                    <span className={`result ${run.status}`}>
                      <span aria-hidden="true">{RESULT_GLYPH[run.status]}</span>{' '}
                      {run.status.replace('_', ' ')}
                    </span>
                    <span>
                      {run.durationMs} ms{costNote(run)} <span className="row-arrow">↗</span>
                    </span>
                  </button>
                ))
              ) : (
                <div className="empty-evidence">No probes yet. Start with discovery above.</div>
              )}
            </div>
            {selected && (
              <details className="inspector" key={selected.id}>
                <summary>
                  Inspect {selected.kind} evidence <code>{selected.id.slice(0, 8)}</code>
                </summary>
                {selected.kind === 'lamp' && <p>{(selected.output as LampResult).explanation}</p>}
                <pre>{JSON.stringify(selected, null, 2)}</pre>
              </details>
            )}
          </div>
          <aside className="readiness">
            <span className="tiny">LIVE PROOF CHECKLIST</span>
            <h3>
              {proofCount}
              <span> / 4</span>
            </h3>
            <p>Fixture runs never count toward live proof.</p>
            {(['text', 'discover', 'segment', 'lamp'] as const).map((kind) => (
              <div className="proof-row" key={kind}>
                <span className={`ring ${status?.liveEvidence[kind] ? 'done' : ''}`}>
                  {status?.liveEvidence[kind] ? '✓' : ''}
                </span>
                {
                  {
                    text: 'Spark connection',
                    discover: 'Real desk discovery',
                    segment: 'Real mug mask',
                    lamp: 'HA state observed',
                  }[kind]
                }
                <small>{status?.liveEvidence[kind] ? 'Saved' : 'Pending'}</small>
              </div>
            ))}
            <div className="setup-note">
              <strong>{metaReady ? 'Meta calls enabled' : 'Meta access pending'}</strong>
              <p>{status?.meta.note ?? 'Checking local configuration…'}</p>
              <strong>{lampReady ? 'Lamp adapter enabled' : 'Lamp setup pending'}</strong>
              <p>{status?.lamp.note}</p>
              <small>
                {status
                  ? `${status.meta.usedToday} / ${status.meta.requestLimit} Meta attempts today (UTC) · ≈ ${usd(status.meta.spentToday)} spent`
                  : 'No outbound calls on startup.'}
              </small>
            </div>
          </aside>
        </section>
      </main>
      <footer>
        <span>
          <Glyph />
          Living Layer
        </span>
        <p>Perception first. A little magic later.</p>
        <span className="tiny">MIT LICENSED</span>
      </footer>
    </div>
  );
}
