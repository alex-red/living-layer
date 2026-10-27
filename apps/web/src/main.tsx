import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  EvidenceRun,
  LabStatus,
  Mode,
  Scene,
  Segmentation,
  LampResult,
} from '@livinglayer/domain';
import './styles.css';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message ?? 'The local server could not complete this request.');
  return data as T;
}
function Glyph({ type = 'layers' }: { type?: 'layers' | 'arrow' | 'camera' | 'upload' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {type === 'layers' ? (
        <>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </>
      ) : type === 'arrow' ? (
        <path d="M4 12h16m-6-6 6 6-6 6" />
      ) : type === 'camera' ? (
        <>
          <path d="M3 7h4l2-3h6l2 3h4v13H3Z" />
          <circle cx="12" cy="13" r="4" />
        </>
      ) : (
        <>
          <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
        </>
      )}
    </svg>
  );
}
function App() {
  const [mode, setMode] = useState<Mode>('fixture');
  const [status, setStatus] = useState<LabStatus>();
  const [runs, setRuns] = useState<EvidenceRun[]>([]);
  const [image, setImage] = useState<string>();
  const [dimensions, setDimensions] = useState({ width: 960, height: 640 });
  const [scene, setScene] = useState<Scene>();
  const [segmentation, setSegmentation] = useState<Segmentation>();
  const [concept, setConcept] = useState('mug');
  const [overlay, setOverlay] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState(
    'Start with the illustrated desk. Every fixture result is labeled.',
  );
  const [selected, setSelected] = useState<EvidenceRun>();
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const cameraGeneration = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const imageGeneration = useRef(0);
  const mounted = useRef(true);
  const refresh = async () => {
    const [nextStatus, nextRuns] = await Promise.all([
      api<LabStatus>('status'),
      api<EvidenceRun[]>('runs'),
    ]);
    setStatus(nextStatus);
    setRuns(nextRuns);
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() =>
      setError('The local API is unavailable. Start both services with npm run dev.'),
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
    setImage(undefined);
    setDimensions({ width: 960, height: 640 });
    setScene(undefined);
    setSegmentation(undefined);
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
      if (kind === 'segment') setSegmentation(run.output as Segmentation);
      setSelected(run);
      setMessage(
        kind === 'segment' && run.status === 'no_match'
          ? 'No match. The previous mask has been cleared.'
          : `${mode === 'fixture' ? 'Fixture' : 'Live'} ${kind} probe saved · ${run.durationMs} ms.`,
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
  const metaReady = Boolean(
    status?.meta.configured &&
    status.meta.enabled &&
    status.meta.creditsConfirmed &&
    status.meta.usedToday < status.meta.requestLimit,
  );
  const lampReady = Boolean(status?.lamp.configured && status.lamp.enabled);
  const canVision = !busy && (mode === 'fixture' || (metaReady && Boolean(image)));
  const proofCount = status ? Object.values(status.liveEvidence).filter(Boolean).length : 0;
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="LivingLayer home">
          <span className="brand-icon">
            <Glyph />
          </span>
          LivingLayer<span className="wordmark-sub">DESK LAB</span>
        </a>
        <span className="edition">
          FIELD NOTES <span>01 / FOUNDATION</span>
        </span>
        <a className="export" href="/api/evidence" download>
          Export evidence <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">
              <span className="dot" /> SOLO INDIE / DAY 01
            </p>
            <h1>
              A little context.
              <br />
              <em>A living space.</em>
            </h1>
            <p className="lede">
              Find the objects. See the mask. Test one light.
              <br />
              Build the evidence before connecting the loop.
            </p>
          </div>
          <aside className="session-note">
            <span className="tiny">TODAY’S EXPERIMENT</span>
            <p>
              Can we turn a desk scene
              <br />
              into something actionable?
            </p>
            <span className="note-rule" />
            <span className="tiny">SPARK → SAM → HOME ASSISTANT</span>
            <span className="note-foot">Independent probes · no automatic triggers</span>
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
                <span className={`dot ${mode === 'live' ? 'gold' : ''}`} />
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
                <svg
                  className="mask-overlay"
                  viewBox={`0 0 ${segmentation.frame.width} ${segmentation.frame.height}`}
                  aria-label={`${segmentation.detections.length} segmentation masks`}
                >
                  {segmentation.detections.map((d, i) => (
                    <g key={`${d.objectId}-${i}`}>
                      <path
                        d={d.mask.svgPath}
                        transform={`translate(${d.box.x} ${d.box.y}) scale(${d.box.width / d.mask.width} ${d.box.height / d.mask.height})`}
                        fill="#dcab35"
                        fillRule="evenodd"
                        fillOpacity=".48"
                      />
                      <rect
                        x={d.box.x}
                        y={d.box.y}
                        width={d.box.width}
                        height={d.box.height}
                        rx="3"
                        stroke="#9c7010"
                        strokeWidth="2"
                        fill="none"
                        strokeDasharray="6 4"
                      />
                      <text
                        x={d.box.x}
                        y={d.box.y - 10}
                        fill="#334a3c"
                        fontSize="16"
                        fontFamily="monospace"
                      >
                        {segmentation.concept} / #{d.objectId}
                      </text>
                    </g>
                  ))}
                </svg>
              )}
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
            <div className="probe">
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
            </div>
            <div className="probe">
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
                className="secondary"
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
              <p className="micro">
                {segmentation
                  ? `${segmentation.detections.length} mask(s) · official Meta parser · ${mode}`
                  : 'Crop-local mask → source-pixel overlay'}
              </p>
            </div>
            <div className="probe">
              <div className="probe-title">
                <span className="step">03</span>
                <h3>Test one light</h3>
                <span className="model-tag">HA</span>
              </div>
              <p>
                {mode === 'fixture'
                  ? 'Virtual lamp only. No hardware action.'
                  : 'Turns on your configured lamp. Check the physical effect separately.'}
              </p>
              <button
                className="secondary"
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
            </div>
          </aside>
        </div>
        <div className="feedback" role="status" aria-live="polite">
          <span className="dot" />
          {message}
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
                    <span className={`result ${run.status}`}>{run.status.replace('_', ' ')}</span>
                    <span>
                      {run.durationMs} ms <span className="row-arrow">↗</span>
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
                <span>{status?.liveEvidence[kind] ? '✓' : '○'}</span>
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
                  ? `${status.meta.usedToday} / ${status.meta.requestLimit} Meta attempts today (UTC)`
                  : 'No outbound calls on startup.'}
              </small>
            </div>
          </aside>
        </section>
      </main>
      <footer>
        <span>
          <Glyph />
          LivingLayer
        </span>
        <p>Perception first. A little magic later.</p>
        <span className="tiny">DAY 01 / BUILD THE FOUNDATION</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
