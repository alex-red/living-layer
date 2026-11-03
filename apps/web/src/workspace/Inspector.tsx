import { useState } from 'react';
import { useNow } from '../useNow';
import {
  MAX_OTHER_OBJECTS,
  OBSERVATION_MAX_AGE_MS,
  exposedEntityId,
  isMugConcept,
  keyFromName,
  objectById,
  ruleWho,
  type DeskMemory,
  type EvidenceRun,
  type PlacementDecision,
  ILLUSTRATION_NOTE_MAX,
} from '@livinglayer/domain';
import { api } from '../api';
import { estimateLabel } from '../cost';
import { Glyph } from '../Glyph';
import { Button, Check, Field, Select } from '../ui/controls';
import { useLab } from './LabContext';
import { Cost, Details, Panel, useCall } from './panel';
import {
  BuiltInPanel,
  FixturePanel,
  LampPanel,
  NewFixturePanel,
  ScanFixtures,
} from './FixturePanel';
import { EntityPanel, NewEntityPanel } from './ExposePanel';
import { ChooseDevicesLink, DevicesPanel } from './DevicesPanel';
import { ago, mainSurface, roomLabel, surfaceRows } from './labels';
import { pinScene, viewLabel, type Selection } from './progress';
import { TRANSITION, centre } from './useLabState';

type Events = { memory: DeskMemory; events: EvidenceRun<PlacementDecision>[] };

/** A ring that empties as a sighting ages towards the 5-minute expiry. */
function Freshness({ observedAt }: { observedAt: string }) {
  const now = useNow();
  const left = Math.max(0, 1 - (now - Date.parse(observedAt)) / OBSERVATION_MAX_AGE_MS);
  const c = 2 * Math.PI * 6;
  return (
    <svg
      className={`freshness ${left === 0 ? 'stale' : ''}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <circle
        cx="8"
        cy="8"
        r="6"
        strokeDasharray={`${c * left} ${c}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
const verdictSummary = (memory: DeskMemory | undefined, events: EvidenceRun<PlacementDecision>[]) =>
  events.length
    ? events
        .map((e) => {
          const r = memory?.rules?.find((x) => x.id === e.output.ruleId);
          return `${r?.label ?? 'Zone'}: ${e.output.decision}${e.output.action !== 'none' ? `, light ${e.output.lamp?.action === 'off' ? 'off ' : ''}${e.output.action}` : ''}`;
        })
        .join(' · ')
    : 'No rules to check.';

/** Masks from the newest segmentation: confirm the mug, or remember another object. */
function MaskResults() {
  const lab = useLab();
  const { segmentation, sorted, confirmedId, segmentRunId, memory, mode, busy } = lab;
  const { call, off } = useCall();
  const [names, setNames] = useState<Record<string, string>>({});
  if (!segmentation) return null;
  if (!sorted.length)
    return (
      <p className="micro">
        No “{segmentation.concept}” found in this frame. Try another name, or move the camera.
      </p>
    );
  const mug = isMugConcept(segmentation.concept);
  const others = memory?.others ?? [];
  return (
    <div className="mask-results">
      <table className="detections">
        <caption>
          {sorted.length} mask{sorted.length === 1 ? '' : 's'} for “{segmentation.concept}” ·{' '}
          {segmentation.frame.width}×{segmentation.frame.height}
        </caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">SCORE</th>
            <th scope="col">AREA</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d.objectId} className={d.objectId === confirmedId ? 'chosen' : ''}>
              <td>
                {d.objectId === confirmedId ? '✓ ' : ''}#{d.objectId}
              </td>
              <td>{d.confidence != null ? d.confidence.toFixed(2) : '—'}</td>
              <td>
                {/* The mask raster is crop-local, so scale its fill up to the box. */}
                {(
                  ((d.mask.foregroundPixels / (d.mask.width * d.mask.height)) *
                    d.box.width *
                    d.box.height *
                    100) /
                  (segmentation.frame.width * segmentation.frame.height)
                ).toFixed(1)}
                %
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mug ? (
        <>
          <p className="micro">Which outline is your mug? Identity is always your call.</p>
          {sorted.map((d) => (
            <Button
              key={d.objectId}
              disabled={Boolean(busy) || !segmentRunId || d.objectId === confirmedId}
              onClick={async () => {
                await lab.deskAction('select', { segmentRunId, detectionId: d.objectId });
                lab.select({ kind: 'object', id: 'main' });
              }}
            >
              Confirm mug mask #{d.objectId}
            </Button>
          ))}
        </>
      ) : others.length < MAX_OTHER_OBJECTS ? (
        <>
          <p className="micro">Remember an outline as an object to track and write rules for.</p>
          {sorted.map((d) => {
            const name = names[d.objectId] ?? segmentation.concept;
            return (
              <div className="remember-row" key={d.objectId}>
                <input
                  aria-label={`Name for mask #${d.objectId}`}
                  maxLength={40}
                  value={name}
                  onChange={(e) => setNames({ ...names, [d.objectId]: e.target.value })}
                />
                <Button
                  disabled={off || !name.trim() || !segmentRunId}
                  onClick={() =>
                    void call<Events>(
                      'desk/objects/select',
                      { segmentRunId, detectionId: d.objectId, label: name.trim() },
                      (r) => {
                        lab.setMemory(r.memory);
                        lab.setMessage(`Remembered the ${name.trim()}.`);
                        const added = r.memory.others?.at(-1);
                        if (added) lab.select({ kind: 'object', id: added.id });
                      },
                    )
                  }
                >
                  Remember #{d.objectId}
                </Button>
              </div>
            );
          })}
        </>
      ) : (
        <p className="micro">
          {MAX_OTHER_OBJECTS} extra objects is the most this desk remembers. Forget one first.
        </p>
      )}
      {mode === 'demo' && !mug && (
        <p className="micro">
          The demo’s outline finder only knows the mug, the book and the bottle.
        </p>
      )}
    </div>
  );
}

function SetupPanel() {
  const lab = useLab();
  const { progress } = lab;
  return (
    <Panel
      tiny="SETUP"
      title="Get the lamp rule running"
      status={
        progress.next
          ? progress.steps.find((s) => s.id === progress.next)!.detail
          : 'Everything is set up. Move the mug and watch it.'
      }
      tone={progress.next ? 'seen' : 'ok'}
    >
      <ol className="setup-steps">
        {progress.steps.map((s, i) => (
          <li key={s.id} className={s.state}>
            <span className={`ring ${s.state === 'done' ? 'done' : ''}`}>
              {s.state === 'done' ? '✓' : i + 1}
            </span>
            <span>
              <strong>{s.label}</strong>
              <small>{s.detail}</small>
            </span>
            <Button
              variant={s.state === 'current' ? 'primary' : 'text'}
              size="sm"
              disabled={s.state === 'locked'}
              onClick={() => lab.goToStep(s.id)}
            >
              {s.state === 'done' ? 'Open' : 'Go'}
            </Button>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/**
 * Draw a photographed room as a clean isometric picture: Muse Image redraws
 * the current photo, SAM finds the desk in it, and the room shows as that
 * picture with the mug and zones on its desk.
 */
function PictureControls({ view = 'room' }: { view?: 'room' | 'desk' }) {
  const lab = useLab();
  const { memory, mode, image, busy, dimensions } = lab;
  const pinned = memory?.surface?.scene === 'custom';
  const calibrated = Boolean(memory?.camera || mode === 'demo');
  const picture = view === 'desk' ? memory?.deskIllustration : memory?.illustration;
  // The room is drawn from its own photo once it has one; the desk always from this frame.
  const needPhoto =
    mode === 'live' &&
    !image &&
    !(view === 'desk' && lab.camera) &&
    (view === 'desk' || !(memory?.scenePhoto || memory?.illustration));
  const [note, setNote] = useState('');
  const what = view === 'desk' ? 'desk' : 'room';
  const drawnFrom = picture?.drawnFrom;
  const otherSize =
    drawnFrom && (drawnFrom.width !== dimensions.width || drawnFrom.height !== dimensions.height);
  return (
    <div className="picture-controls">
      <Button
        disabled={
          Boolean(busy) ||
          !pinned ||
          needPhoto ||
          (view === 'room' && !calibrated) ||
          (view === 'desk' && mode === 'demo') ||
          (mode === 'live' && !lab.metaReady)
        }
        onClick={() => void lab.illustrate(view, note)}
      >
        {busy === 'illustrate'
          ? 'Drawing…'
          : picture
            ? `Redraw the ${what} picture`
            : view === 'desk'
              ? 'Draw the desk as a picture'
              : 'Draw it as a picture'}
      </Button>
      <p className="micro">
        {view === 'desk' && mode === 'demo'
          ? 'The demo has no desk camera: draw the room instead.'
          : !pinned
            ? 'Pin the desk first: the picture is tied to it.'
            : view === 'room' && !calibrated
              ? 'Calibrate the corner camera first.'
              : needPhoto
                ? view === 'desk'
                  ? 'Capture a close frame of the desk first.'
                  : 'Add a frame from the room’s camera first.'
                : mode === 'demo'
                  ? 'Demo: no model calls.'
                  : view === 'desk'
                    ? otherSize
                      ? `Drawn from a ${drawnFrom!.width}×${drawnFrom!.height} frame: redraw to match this one.`
                      : `Redraws this frame${memory?.illustration ? ' in the room’s style' : ''}, keeping its framing · 1 image call, ~$0.01.`
                    : `Redraws ${memory?.scenePhoto || memory?.illustration ? 'the room’s photo' : 'the current frame'} as line art, keeping the camera’s framing · 1 image call, ~$0.01.`}
      </p>
      {picture && mode === 'live' && (
        <>
          <Field
            label="What to change (optional)"
            hint={
              view === 'desk'
                ? lab.camera
                  ? 'Redrawn from what the camera shows now.'
                  : 'Redrawn from the frame on the stage.'
                : 'Without a note, the photo redraws much the same.'
            }
          >
            <input
              id={`redraw-note-${view}`}
              value={note}
              maxLength={ILLUSTRATION_NOTE_MAX}
              placeholder="e.g. simpler shapes, warmer light, leave out the cables"
              disabled={Boolean(busy)}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void lab.illustrate(view, note);
              }}
            />
          </Field>
        </>
      )}
      {view === 'room' && picture?.drawnFrom && <LiftFixtures />}
    </div>
  );
}
/**
 * Lift the room's fixtures off its picture: each becomes its own cut-out
 * over a base drawn without them, so moving a fixture moves the thing.
 */
function LiftFixtures() {
  const lab = useLab();
  const { memory, mode, busy } = lab;
  const pinScene = memory?.surface?.scene;
  const count = (memory?.fixtures ?? []).filter((f) => f.scene === pinScene).length;
  const layers = memory?.illustration?.layers;
  const blocked = Boolean(busy) || !count || (mode === 'live' && !lab.metaReady);
  return (
    <div className="lift-fixtures">
      <div className="lift-actions">
        <Button disabled={blocked} onClick={() => void lab.separate()}>
          {busy === 'separate'
            ? 'Lifting…'
            : layers
              ? 'Lift them again'
              : 'Lift the fixtures off the picture'}
        </Button>
        {layers && (
          <Button variant="text" disabled={Boolean(busy)} onClick={() => void lab.separate(true)}>
            Put them back
          </Button>
        )}
      </div>
      <p className="micro">
        {!count
          ? 'Scan or add this room’s fixtures first.'
          : layers
            ? `${layers.sprites.length} of ${count} fixtures lifted. Lift again after adding more.`
            : mode === 'demo'
              ? 'Cuts each fixture out so you can drag it. No model calls.'
              : 'Cuts each fixture out of the picture so you can drag it · Spark, SAM and 1 image call, ~$0.02.'}
      </p>
    </div>
  );
}
function RoomPanel() {
  const lab = useLab();
  const { progress, memory, mode, image, busy, guess, workScene } = lab;
  const room = progress.room!;
  const rows = surfaceRows(lab);
  return (
    <Panel
      tiny="ROOM"
      title={roomLabel(room, memory)}
      status={
        room === 'custom'
          ? 'Your own room, drafted from a photo or built by hand.'
          : lab.isoPanel === 'scene' && lab.stageView !== 'photo'
            ? 'Editing the layout in the canvas. Save it when it looks right.'
            : room === 'office'
              ? 'The demo office: an illustrated preset you can edit.'
              : 'A preset scene. Pin one of its surfaces to place objects.'
      }
      tone="ok"
    >
      {lab.isoPanel === 'scene' && lab.stageView !== 'photo' ? (
        <Button onClick={() => lab.setIsoPanel('room')}>Done editing</Button>
      ) : (
        <Button variant="primary" disabled={!workScene} onClick={lab.editLayout}>
          Edit layout
        </Button>
      )}
      {room === 'custom' && <PictureControls />}
      {memory?.surface && pinScene(room) === memory.surface.scene && (
        <Button
          variant="text"
          disabled={Boolean(lab.busy) || Boolean(lab.pinning)}
          onClick={() => void lab.adjustPin()}
        >
          Adjust the pin’s corners on the photo →
        </Button>
      )}
      {mode === 'live' && (
        <Button
          variant="text"
          disabled={
            Boolean(lab.busy) || Boolean(lab.calibrating) || !(lab.camera || Boolean(image))
          }
          title="Drag the far corner and the walls' floor lines on the current frame, and add height lines up to things of known height. No model calls."
          onClick={lab.calibrateHere}
        >
          Calibrate the camera by hand →
        </Button>
      )}
      <ScanFixtures initial={pinScene(room)} open />
      {progress.view && (
        <Button variant="text" onClick={() => lab.select({ kind: 'view' })}>
          {progress.pinned ? 'Open the' : 'Next: set up the'}{' '}
          {viewLabel(progress.view).toLowerCase()} →
        </Button>
      )}
      <Field label="Room">
        <Select
          aria-label="Room"
          value={room}
          disabled={Boolean(busy)}
          onChange={(v) => lab.pickScene(v)}
          options={[
            { value: 'office', label: 'Office' },
            { value: 'fridge', label: 'Fridge' },
            ...(memory?.scene ? [{ value: 'custom' as const, label: memory.scene.label }] : []),
          ]}
        />
      </Field>
      {rows.room.length > 0 && (
        <Details summary={`Surfaces · ${rows.room.length + rows.view.length}`} open>
          <ul className="insp-list">
            {[...rows.view, ...rows.room].map((r) => (
              <li key={r.surface.id}>
                <Button
                  variant="text"
                  onClick={() => lab.select({ kind: 'surface', id: r.surface.id })}
                >
                  {r.surface.label}
                </Button>
                <small>{r.pinned ? '✓ pinned' : '◌ not pinned'}</small>
              </li>
            ))}
          </ul>
        </Details>
      )}
      <Details summary="Ask Spark">
        <p className="micro">
          Spark names the preset and props in the photo. It never places them.
        </p>
        <Button
          disabled={Boolean(busy) || lab.asking || room === 'custom' || (mode === 'live' && !image)}
          onClick={() => void lab.askGuess()}
        >
          {lab.asking ? 'Asking Spark…' : 'Guess scene'}
        </Button>
        {guess && <p className="micro">Spark: {guess.summary}</p>}
      </Details>
    </Panel>
  );
}

/** Pin a surface to the camera frame: the bridge between the photo and the iso room. */
function SurfacePanel({ id, closeView }: { id: string; closeView?: boolean }) {
  const lab = useLab();
  const { memory, mode, image, busy, progress, pinning } = lab;
  const rows = surfaceRows(lab);
  const row = [...rows.view, ...rows.room].find((r) => r.surface.id === id);
  if (!row)
    return (
      <Panel
        tiny="SURFACE"
        title="No surface"
        status="This scene has no surface to pin."
        tone="unsure"
      >
        <Button onClick={lab.editLayout}>Edit layout</Button>
      </Panel>
    );
  const label = row.surface.label.toLowerCase();
  const demoPin = mode === 'demo' && !memory?.surface && row.pinned;
  // A running camera's frame is a photo too: pinning takes it.
  const needPhoto = mode === 'live' && !image && !lab.camera;
  const title = closeView && progress.view ? viewLabel(progress.view) : row.surface.label;
  // The room's calibrated camera sees every surface of the room; a close view has its own camera.
  const findable = !closeView && Boolean(memory?.camera || mode === 'demo');
  return (
    <Panel
      tiny={
        closeView
          ? `CLOSE VIEW · IN THE ${roomLabel(progress.room, memory).toUpperCase()}`
          : 'SURFACE'
      }
      title={title}
      status={
        demoPin
          ? `The demo ${label} is pinned for you.`
          : row.pinned
            ? `Pinned on a ${memory!.surface!.frame.width}×${memory!.surface!.frame.height} frame.`
            : needPhoto
              ? `Add a close photo of the ${label}, then pin its four corners.`
              : `Pin the ${label} to place objects on it.`
      }
      tone={row.pinned ? 'ok' : 'seen'}
    >
      {row.pinned ? (
        <Button
          variant="primary"
          onClick={() =>
            lab.select(memory?.object ? { kind: 'object', id: 'main' } : { kind: 'add' })
          }
        >
          {memory?.object ? `Open ${memory.object.label}` : 'Find objects'} <Glyph type="arrow" />
        </Button>
      ) : needPhoto ? (
        <div className="save-actions">
          <Button
            variant="primary"
            disabled={Boolean(busy)}
            onClick={() => lab.file.current?.click()}
          >
            Upload a frame
          </Button>
          <Button
            disabled={Boolean(busy) || lab.cameraPending || lab.camera}
            onClick={() => void lab.startCamera()}
          >
            Use the camera
          </Button>
        </div>
      ) : null}
      {closeView && row.pinned && progress.view && (
        <p className="micro">
          Shared with the {roomLabel(progress.room, memory).toLowerCase()}: what you place here
          shows there too.
        </p>
      )}
      {closeView && row.pinned && progress.view === 'custom-desk' && (
        <PictureControls view="desk" />
      )}
      {closeView && row.pinned && progress.view && (
        <ScanFixtures initial={pinScene(progress.view)} open />
      )}
      <div className="save-actions">
        {findable && (
          <Button
            variant={row.pinned ? 'secondary' : 'primary'}
            disabled={Boolean(busy) || Boolean(pinning) || lab.camera}
            onClick={() =>
              void lab.autoPin({ scene: pinScene(row.scene), surfaceId: row.surface.id, label })
            }
          >
            {busy === 'autopin' ? 'Finding…' : row.pinned ? 'Find it again' : `Find the ${label}`}
          </Button>
        )}
        <Button
          variant={row.pinned || needPhoto || findable ? 'secondary' : 'primary'}
          disabled={Boolean(busy) || Boolean(pinning) || needPhoto}
          onClick={() =>
            lab.pinHere({ scene: pinScene(row.scene), surfaceId: row.surface.id, label })
          }
        >
          {row.pinned && memory?.surface ? 'Re-pin surface' : 'Pin surface'}
        </Button>
        {memory?.surface && row.pinned && (
          <Button
            variant="text"
            disabled={Boolean(busy)}
            onClick={() => void lab.deskAction('surface', { pin: null })}
          >
            Clear pin
          </Button>
        )}
      </div>
      <p className="micro">
        {memory?.camera
          ? `Camera calibrated (${memory.camera.error.toFixed(1)} px)${memory.camera.moved ? ', but it has moved: zones pause until you calibrate again' : ''}.`
          : mode === 'demo'
            ? 'The demo camera is calibrated. Calibrate again to try the marks.'
            : 'Mount a camera high in a corner, then calibrate it so room zones apply to its frames.'}
      </p>
      <div className="save-actions">
        {/* Secondary even uncalibrated: the pin or photo action above is this step's primary. */}
        <Button
          disabled={Boolean(busy) || Boolean(pinning) || lab.camera || needPhoto}
          onClick={() => void lab.startCalibrating()}
        >
          {busy === 'calibrate'
            ? 'Finding the floor…'
            : memory?.camera
              ? 'Calibrate again'
              : 'Calibrate the camera'}
        </Button>
        {memory?.camera && (
          <Button
            variant="text"
            disabled={Boolean(busy)}
            onClick={() =>
              void api<DeskMemory>('room/forget', { mode }).then((m) => lab.setMemory(m))
            }
          >
            Forget calibration
          </Button>
        )}
      </div>
      {closeView && (
        <Details summary="Start over">
          <p className="micro">
            Forget the mug, its zone and its sightings. The evidence log stays.
          </p>
          <Button
            variant="danger"
            disabled={Boolean(busy) || !memory?.object}
            onClick={() => void lab.deskAction('reset')}
          >
            Reset desk memory
          </Button>
        </Details>
      )}
    </Panel>
  );
}

/** Find an object: Discover suggests what is there, SAM outlines a name, you confirm. */
function AddPanel({
  concept: preset,
}: {
  concept?: { label: string; category: string; appearance: string };
}) {
  const lab = useLab();
  const { mode, image, camera, canVision, busy, status, concept, scene } = lab;
  const needPhoto = mode === 'live' && !image && !camera;
  return (
    <Panel
      tiny={preset ? 'SUGGESTED BY SPARK' : 'ADD AN OBJECT'}
      title={preset ? preset.label : 'Find an object'}
      status={
        preset
          ? `${preset.appearance}. Find its outline, then confirm it.`
          : needPhoto
            ? 'Add a photo of the desk first: start the camera, or upload one.'
            : camera
              ? 'Name what to look for; SAM outlines every match the camera shows.'
              : 'Name what to look for; SAM outlines every match in this frame.'
      }
      tone={needPhoto ? 'unsure' : 'seen'}
    >
      {preset ? (
        <Button
          variant="primary"
          disabled={!canVision}
          onClick={() => {
            lab.setConcept(preset.category);
            void lab.execute('segment', preset.category);
          }}
        >
          {busy === 'segment' ? 'Decoding…' : 'Find its outline'}
          <Glyph type="arrow" />
        </Button>
      ) : (
        <>
          <label className="input-label" htmlFor="concept">
            Object concept
          </label>
          <div className="concept-input">
            <input
              id="concept"
              value={concept}
              maxLength={80}
              onChange={(e) => lab.setConcept(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canVision && concept.trim()) void lab.execute('segment');
              }}
            />
            <span>↵ TO RUN</span>
          </div>
          <Button
            variant="primary"
            disabled={!canVision || !concept.trim()}
            onClick={() => void lab.execute('segment')}
          >
            {busy === 'segment' ? 'Decoding…' : 'Segment object'}
            <Glyph type="arrow" />
          </Button>
        </>
      )}
      {status && <Cost>{estimateLabel(status.meta.estimates.segment, 'image')}</Cost>}
      <MaskResults />
      {!preset && (
        <Details summary="Not sure what’s there?" open={!scene}>
          <p className="micro">Spark suggests up to three objects on the desk.</p>
          <Button disabled={!canVision} onClick={() => void lab.execute('discover')}>
            {busy === 'discover' ? 'Discovering…' : 'Discover objects'}
          </Button>
          {status && <Cost>{estimateLabel(status.meta.estimates.discover)}</Cost>}
          {scene && (
            <>
              <p className="scene-summary micro">{scene.summary}</p>
              <div className="object-grid">
                {scene.objects.map((object, i) => (
                  <button
                    key={i}
                    disabled={Boolean(busy)}
                    onClick={() => {
                      lab.setConcept(object.category);
                      lab.select({ kind: 'suggested', index: i });
                    }}
                    className={`object-card ${concept === object.category ? 'chosen' : ''}`}
                  >
                    <strong>{object.label}</strong>
                    <small>{object.appearance}</small>
                  </button>
                ))}
              </div>
              {!scene.objects.length && <p className="micro">No suitable objects were returned.</p>}
            </>
          )}
        </Details>
      )}
      <Details summary="Check for false matches">
        <p className="micro">Ask for something that isn’t there: a good result is no outline.</p>
        <Button
          variant="text"
          disabled={!canVision}
          onClick={() => void lab.execute('segment', 'unicorn')}
        >
          Test absent target <span>↗</span>
        </Button>
      </Details>
    </Panel>
  );
}

const WATCH_STATE = {
  off: 'Off',
  starting: 'Starting',
  watching: 'Watching',
  paused: 'Paused',
  camera_lost: 'Camera lost',
} as const;
/**
 * The server's watcher: on, it follows every confirmed thing in the camera
 * and fires rules on SAM's answers whether or not a tab is open.
 */
function WatchControl() {
  const lab = useLab();
  const { watch, watching, canWatch, mode } = lab;
  const stats =
    watch &&
    `${watch.frames} frame${watch.frames === 1 ? '' : 's'} · ${watch.checks} SAM check${watch.checks === 1 ? '' : 's'}${watch.appearance ? ` · ${watch.refinds} found by appearance` : ''}`;
  return (
    <>
      <Button
        disabled={!watching && !canWatch}
        onClick={() => void lab.toggleWatch()}
        title={
          watching
            ? 'Pause watching until the server starts again: it watches by default'
            : 'The server follows every confirmed thing in the camera and checks zone crossings with SAM, with or without this tab'
        }
      >
        {watching ? 'Pause watching' : 'Watch on the server'}
      </Button>
      <p className="micro">
        {watching && watch
          ? `${WATCH_STATE[watch.state]}${watch.camera ? ` ${watch.camera.name}` : ''} · ${stats}. ${watch.note}`
          : canWatch
            ? `Follows everything confirmed with no tab open, asking SAM only at zone edges${mode === 'live' ? '' : ' (here, each move is a frame)'}.`
            : 'Needs an RTSP network camera (see scripts/share-camera.sh). Follow it in this tab instead.'}
      </p>
    </>
  );
}

function MugPanel() {
  const lab = useLab();
  const { memory, mode, camera, busy, status, follow, followView, followStats, localZone } = lab;
  const { currentObservation, sightings } = lab;
  const now = useNow();
  const observationStale = memory?.observation
    ? now - Date.parse(memory.observation.observedAt) > OBSERVATION_MAX_AGE_MS
    : false;
  if (!memory?.object)
    return (
      <Panel
        tiny="OBJECT · MAIN"
        title="No mug yet"
        status="Find the mug and confirm its outline first."
        tone="unsure"
      >
        <Button variant="primary" onClick={() => lab.select({ kind: 'add' })}>
          Find the mug
        </Button>
      </Panel>
    );
  const o = memory.observation;
  const seen = o ? ago(o.observedAt, now) : '';
  return (
    <Panel
      tiny="OBJECT · MAIN"
      title={memory.object.label}
      status={
        !o
          ? 'Remembered, but not seen yet. Track it in a frame.'
          : currentObservation
            ? `Confirmed in this frame · seen ${seen}.`
            : observationStale
              ? `Seen ${seen}, so it may have moved. Track it in a new frame.`
              : `Seen ${seen} in an earlier frame. Track it in this frame to continue.`
      }
      tone={currentObservation ? 'chosen' : observationStale ? 'unsure' : 'seen'}
      aside={o && <Freshness observedAt={o.observedAt} />}
    >
      <Button
        variant="primary"
        disabled={!lab.canTrack}
        onClick={() => void lab.track()}
        title="Segment the mug in the current frame, match it to the remembered mug, and check the zone"
      >
        {busy === 'track'
          ? 'Tracking…'
          : mode === 'live' && camera
            ? 'Capture & track'
            : 'Track the mug'}
        <Glyph type="arrow" />
      </Button>
      <p className="micro">
        {mode === 'demo'
          ? 'Move the mug with the buttons under the canvas, then track it.'
          : 'Move the mug, start the camera, then capture & track.'}
      </p>
      {status && <Cost>{estimateLabel(status.meta.estimates.segment, 'track')}</Cost>}
      <WatchControl />
      {!lab.canWatch && (
        <>
          <Button
            disabled={follow ? false : Boolean(busy) || !currentObservation}
            onClick={() => (follow ? lab.stopFollow() : void lab.startFollow())}
            title="Follow the mug frame to frame in the browser, calling SAM only at the zone edge or when the match gets weak"
          >
            {follow ? 'Stop following' : 'Follow locally'}
          </Button>
          <p className="micro">
            {follow
              ? `${followStats.frames} local step${followStats.frames === 1 ? '' : 's'} · ${followStats.checks} SAM check${followStats.checks === 1 ? '' : 's'}${followView ? ` · match ${followView.track.score.toFixed(2)}` : ''}${localZone ? '' : ' · no zone to watch: save one and mark the camera fixed'}`
              : currentObservation
                ? 'Follows the mug in this tab; SAM confirms each zone crossing.'
                : 'Track the mug in this frame first.'}
          </p>
        </>
      )}
      <div className="insp-links">
        <Button variant="text" onClick={() => lab.select({ kind: 'rule', id: 'main' })}>
          {memory.zone ? 'Zone and light' : 'Draw its zone'} →
        </Button>
        <Button variant="text" disabled={Boolean(busy)} onClick={() => lab.openModel(undefined)}>
          Edit model {memory.item ? '· fitted' : ''} →
        </Button>
      </div>
      {sightings.length > 0 && (
        <Details
          summary={`History · ${sightings.length} sighting${sightings.length === 1 ? '' : 's'}`}
        >
          <div className="timeline">
            <ol>
              {sightings.map((s, i) => {
                const here = centre(s);
                const before = sightings[i + 1];
                const moved = before
                  ? Math.hypot(here.x - centre(before).x, here.y - centre(before).y) * 100
                  : null;
                const verdict = lab.verdictFor(s);
                return (
                  <li key={s.id} className={i === 0 ? 'current' : ''}>
                    <span className={`transition ${verdict?.transition ?? 'none'}`}>
                      {verdict?.transition
                        ? TRANSITION[verdict.transition]
                        : verdict
                          ? 'Blocked'
                          : 'Not checked'}
                    </span>
                    <span className="micro">
                      {new Date(s.observedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}{' '}
                      · at {Math.round(here.x * 100)},{Math.round(here.y * 100)}%
                      {moved !== null && ` · moved ${moved.toFixed(1)}%`}
                      {verdict?.assumedFixedCamera && ' · carried zone'}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </Details>
      )}
      <Details summary="Forget">
        <p className="micro">Forget the mug, its zone and its sightings. The evidence log stays.</p>
        <Button
          variant="danger"
          disabled={Boolean(busy)}
          onClick={() => void lab.deskAction('reset')}
        >
          Reset desk memory
        </Button>
      </Details>
    </Panel>
  );
}

function OtherPanel({ id }: { id: string }) {
  const lab = useLab();
  const { memory, segmentation, segmentRunId, canVision } = lab;
  const { call, off } = useCall();
  const now = useNow();
  const o = memory?.others?.find((x) => x.id === id);
  if (!o) return <SetupPanel />;
  const canTrack =
    segmentation &&
    segmentRunId &&
    segmentRunId !== o.observation?.segmentRunId &&
    segmentation.concept.trim().toLowerCase() === o.concept.trim().toLowerCase();
  return (
    <Panel
      tiny={`OBJECT · ${o.concept.toUpperCase()}`}
      title={o.label}
      status={
        o.observation
          ? `Seen ${ago(o.observation.observedAt, now)} · found as “${o.concept}”.`
          : `Remembered · found as “${o.concept}”.`
      }
      tone="chosen"
      aside={o.observation && <Freshness observedAt={o.observation.observedAt} />}
    >
      {canTrack ? (
        <Button
          variant="primary"
          disabled={off}
          onClick={() =>
            void call<Events>('desk/objects/track', { objectId: o.id, segmentRunId }, (r) => {
              lab.setMemory(r.memory, false);
              lab.setMessage(`Tracked the ${o.label}. ${verdictSummary(r.memory, r.events)}`);
            })
          }
        >
          Track
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled={!canVision}
          onClick={() => void lab.execute('segment', o.concept)}
        >
          Find it in this frame
        </Button>
      )}
      <p className="micro">
        {canTrack
          ? `The newest outlines are of “${o.concept}”. Match one to the ${o.label}.`
          : 'Outline it in this frame, then track it.'}
      </p>
      <div className="insp-links">
        {lab.entities.length > 0 && o.observation && (
          <Button variant="text" onClick={() => lab.startRule(o.id)}>
            Add a rule for it →
          </Button>
        )}
        <Button variant="text" disabled={off} onClick={() => lab.openModel(o.id)}>
          Edit model →
        </Button>
      </div>
      <Details summary="Forget">
        <Button
          variant="danger"
          disabled={off}
          onClick={() =>
            void call<DeskMemory>('desk/objects/forget', { objectId: o.id }, (m) => {
              lab.setMemory(m);
              lab.setMessage(`Forgot the ${o.label} and its zones.`);
              lab.select(null);
            })
          }
        >
          Forget the {o.label}
        </Button>
      </Details>
    </Panel>
  );
}

/**
 * The camera moved since it was calibrated, so every zone is paused: calibrate
 * again from the old marks, or keep the calibration and redraw zones.
 */
function CameraMoved() {
  const lab = useLab();
  const { memory, mode, busy, pinning } = lab;
  if (!memory?.camera?.moved) return null;
  return (
    <div className="save-actions">
      <Button
        variant="primary"
        disabled={Boolean(busy) || Boolean(pinning)}
        // Demo frames come from the server, so the demo finds its marks there (no model calls).
        onClick={() => (mode === 'demo' ? void lab.startCalibrating() : lab.calibrateHere())}
      >
        Calibrate again
      </Button>
      <Button
        disabled={Boolean(busy) || Boolean(pinning)}
        onClick={() => void lab.keepCameraView()}
      >
        {busy === 'calibrate' ? 'Keeping…' : 'Keep calibration'}
      </Button>
    </div>
  );
}

/** The mug's own zone and the main lamp. */
function ZonePanel() {
  const lab = useLab();
  const { memory, mode, busy, drawing, draftZone, currentObservation, zoneObservation, lampReady } =
    lab;
  if (!memory?.object)
    return (
      <Panel
        tiny="RULE · MAIN"
        title="Main zone"
        status="Remember the mug first; its zone is drawn on a frame it was seen in."
        tone="unsure"
      >
        <Button variant="primary" onClick={() => lab.select({ kind: 'add' })}>
          Find the mug
        </Button>
      </Panel>
    );
  const d = memory.lastDecision?.output;
  const lampName = mode === 'demo' ? 'virtual lamp' : 'lamp';
  const status = !memory.zone
    ? zoneObservation
      ? 'Draw the zone the mug should be in.'
      : 'Track the mug in this frame, then draw its zone.'
    : !d
      ? 'Zone saved. Check where the mug is to try the rule.'
      : d.decision === 'inside'
        ? d.action === 'confirmed'
          ? `The mug is in the zone. The ${lampName} turned on.`
          : `The mug is still in the zone. The ${lampName} only fires on entering.`
        : d.decision === 'outside'
          ? 'The mug is outside the zone. Nothing to do.'
          : `Blocked: ${d.reason}`;
  return (
    <Panel
      tiny="RULE · MAIN"
      title={`Main zone → ${lab.lights[0] ?? 'main lamp'}`}
      status={status}
      tone={
        !d ? 'seen' : d.decision === 'blocked' ? 'unsure' : d.action === 'confirmed' ? 'warm' : 'ok'
      }
    >
      <p className="rule-sentence">
        When <strong>{memory.object.label}</strong> is inside{' '}
        <strong>{memory.zone ? 'ZN-01' : 'a zone'}</strong>, turn on{' '}
        <strong>{lab.lights[0] ?? 'the main lamp'}</strong>.
      </p>
      <CameraMoved />
      {!drawing && (
        <Button
          disabled={Boolean(busy) || !zoneObservation}
          onClick={() => {
            lab.setDraftZone(memory.zone?.rect ?? { x: 0.3, y: 0.2, width: 0.4, height: 0.6 });
            lab.setDrawing(true);
          }}
        >
          {memory.zone ? 'Edit zone' : 'Draw zone'}
        </Button>
      )}
      {drawing && (
        <div className="zone-editor">
          <p className="micro">
            Drag a rectangle on the photo or the iso surface, or enter percentages.
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
                    // A rectangle edited in the frame is no longer the one drawn in the room.
                    lab.setDraftZone(({ onSurface: _, ...z }) => ({
                      ...z,
                      [key]: Number(e.target.value) / 100,
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <div className="save-actions">
            <Button
              variant="primary"
              disabled={Boolean(busy) || !zoneObservation}
              onClick={() =>
                void lab.deskAction('zone', {
                  observationId: zoneObservation?.id,
                  rect: {
                    x: draftZone.x,
                    y: draftZone.y,
                    width: draftZone.width,
                    height: draftZone.height,
                  },
                  ...(draftZone.onSurface ? { onSurface: draftZone.onSurface } : {}),
                })
              }
            >
              Save zone
            </Button>
            <Button onClick={() => lab.setDrawing(false)}>Cancel</Button>
          </div>
        </div>
      )}
      <Button
        variant="physical"
        disabled={
          Boolean(busy) ||
          drawing ||
          !currentObservation ||
          !memory.zone ||
          (mode === 'live' && !lampReady)
        }
        onClick={() =>
          void lab.deskAction('verify', {
            observationId: currentObservation?.id,
            zoneId: memory.zone?.id,
          })
        }
      >
        {busy === 'verify'
          ? 'Checking placement…'
          : mode === 'demo'
            ? 'Verify placement · virtual lamp'
            : 'Verify placement · turn on lamp'}
      </Button>
      {mode === 'live' && !lampReady && (
        <ChooseDevicesLink why="The lamp isn’t set up yet (or try it in Demo)." />
      )}
      {!currentObservation && memory.zone && (
        <p className="micro">
          Track the mug in this frame first: a still photo doesn’t say where it is now.
        </p>
      )}
      {memory.lastDecision && (
        <Details summary="Last check" open>
          <p className="placement-result" role="note">
            {memory.lastDecision.mode.toUpperCase()} · {memory.lastDecision.output.decision} · lamp{' '}
            {memory.lastDecision.output.action}
            {memory.lastDecision.output.transition && (
              <> · {TRANSITION[memory.lastDecision.output.transition]}</>
            )}
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
        </Details>
      )}
      <Details summary="Camera">
        <Check
          checked={Boolean(memory.fixedCamera)}
          disabled={Boolean(busy)}
          onChange={(fixed) => void lab.deskAction('camera', { fixed })}
        >
          The camera is fixed: keep the zone for new frames of the same size
        </Check>
        <p className="micro">
          {!memory.zone
            ? 'No zone saved yet.'
            : memory.fixedCamera
              ? 'The zone carries over to new frames of this size.'
              : 'The zone applies only to the frame it was drawn on.'}{' '}
          Sightings expire after 5 minutes.
        </p>
      </Details>
    </Panel>
  );
}

function RulePanel({ id }: { id: string }) {
  const lab = useLab();
  const { memory } = lab;
  const { call, off } = useCall();
  const r = memory?.rules?.find((x) => x.id === id);
  if (!r) return <SetupPanel />;
  const d = r.lastDecision?.output;
  const who = memory ? ruleWho(memory, r) : 'something';
  // Who is in it, by name: "mug, book".
  const inside =
    memory && r.inside?.length
      ? r.inside.map((id) => objectById(memory, id)?.label ?? 'thing').join(', ')
      : null;
  const shown = memory?.exposed?.find(
    (e) => e.source.kind === 'in_zone' && e.source.zoneId === r.id,
  );
  return (
    <Panel
      tiny="RULE"
      title={r.label}
      status={
        !d
          ? 'Not checked yet. Track the object or check the rules.'
          : d.decision === 'inside'
            ? d.action === 'confirmed' && r.entityId
              ? `Occupied (${inside ?? 'something'}). ${r.entityId} turned on.`
              : `Occupied (${inside ?? 'something'}).`
            : d.decision === 'outside'
              ? d.action === 'confirmed' && r.entityId
                ? `Empty. ${r.entityId} turned off.`
                : 'Empty.'
              : `Blocked: ${d.reason}`
      }
      tone={
        !d ? 'seen' : d.decision === 'blocked' ? 'unsure' : d.action === 'confirmed' ? 'warm' : 'ok'
      }
    >
      <p className="rule-sentence">
        When <strong>{who}</strong> is inside <strong>{r.label}</strong>,{' '}
        {r.entityId ? (
          <>
            turn on <strong>{r.entityId}</strong>
            {r.offWhenEmpty ? ', and off again when it empties' : ''}.
          </>
        ) : (
          'tell Home Assistant only.'
        )}
      </p>
      <CameraMoved />
      <Button disabled={off} onClick={() => lab.editRule(r.id)}>
        Edit zone and rule
      </Button>
      {shown ? (
        <p className="micro">
          Shown in Home Assistant as{' '}
          <Button variant="text" onClick={() => lab.select({ kind: 'entity', id: shown.id })}>
            {exposedEntityId(shown)}
          </Button>
          .
        </p>
      ) : (
        <Button
          disabled={off}
          onClick={() => {
            const key = keyFromName(r.label) || 'zone';
            const taken = new Set(memory?.exposed?.map((e) => e.key));
            let free = key;
            for (let n = 2; taken.has(free); n++) free = `${key.slice(0, 44)}_${n}`;
            void call<DeskMemory>(
              'expose/save',
              {
                entity: {
                  key: free,
                  name: r.label,
                  kind: 'binary_sensor',
                  deviceClass: 'occupancy',
                  source: { kind: 'in_zone', zoneId: r.id },
                },
              },
              (m) => {
                lab.setMemory(m, false);
                lab.setMessage(
                  `Showing "${r.label}" in Home Assistant as binary_sensor.ll_${free}.`,
                );
              },
            );
          }}
        >
          Also show in Home Assistant
        </Button>
      )}
      <Button
        variant="primary"
        disabled={off}
        onClick={() =>
          void call<Events>('desk/rules/verify', {}, (res) => {
            lab.setMemory(res.memory, false);
            lab.setMessage(verdictSummary(res.memory, res.events));
          })
        }
      >
        Check rules
      </Button>
      <Details summary="Delete">
        <Button
          variant="danger"
          disabled={off}
          onClick={() =>
            void call<DeskMemory>('desk/rules/delete', { ruleId: r.id }, (m) => {
              lab.setMemory(m);
              lab.setMessage(`Removed "${r.label}".`);
              lab.select(null);
            })
          }
        >
          Delete “{r.label}”
        </Button>
      </Details>
    </Panel>
  );
}

/** A rule as a sentence: when [anything, a thing or several] is inside [a zone you drag] turn on [light]. */
function NewRulePanel() {
  const lab = useLab();
  const { memory, ruleDraft: draft, entities } = lab;
  const { call, off } = useCall();
  if (!draft) return <SetupPanel />;
  const objects = [
    ...(memory?.object && memory.observation
      ? [{ id: memory.object.id, label: memory.object.label }]
      : []),
    ...(memory?.others ?? [])
      .filter((o) => o.observation)
      .map((o) => ({ id: o.id, label: o.label })),
    // A fixture the camera follows can decide a rule too.
    ...(memory?.fixtures ?? [])
      .filter((f) => f.track)
      .map((f) => ({ id: f.id, label: `${f.label} (fixture)` })),
  ];
  const set = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    // The saved rule's fixture goes with its entity: another entity is a plain rule.
    if (patch.entityId !== undefined && patch.entityId !== draft.entityId) delete next.fixtureId;
    lab.setRuleDraft(next);
  };
  const ids = objects.map((o) => o.id);
  const who =
    draft.objects === 'any' ? 'any' : draft.objects.length === 1 ? draft.objects[0]! : 'several';
  const editing = Boolean(draft.id);
  const back = () => lab.select(draft.id ? { kind: 'rule', id: draft.id } : null);
  return (
    <Panel
      tiny={editing ? 'EDIT RULE' : 'NEW RULE'}
      title={editing ? `Change “${draft.label.trim() || 'zone'}”` : 'When something is in a zone…'}
      status={
        draft.rect
          ? `Zone ${Math.round(draft.rect.width * 100)}×${Math.round(draft.rect.height * 100)}% of the frame. Drag again on the iso surface to redraw it.`
          : mainSurface(lab) || lab.progress.pinned
            ? 'Drag a rectangle on the iso surface to draw the zone.'
            : 'Pin a surface first, so the zone can be drawn on it.'
      }
      tone={draft.rect ? 'chosen' : 'seen'}
    >
      <div className="rule-builder">
        <span>When</span>
        <Select
          aria-label="Rule object"
          value={who}
          onChange={(value) =>
            set({
              objects:
                value === 'any'
                  ? 'any'
                  : value === 'several'
                    ? draft.objects === 'any'
                      ? ids
                      : draft.objects
                    : [value],
            })
          }
          options={[
            { value: 'any', label: 'anything' },
            ...objects.map((o) => ({ value: o.id, label: o.label })),
            ...(objects.length > 1 ? [{ value: 'several', label: 'any of several…' }] : []),
          ]}
        />
        {who === 'several' && draft.objects !== 'any' && (
          <>
            <span />
            <div className="rule-things">
              {objects.map((o) => {
                const picked = (draft.objects as string[]).includes(o.id);
                return (
                  <Check
                    key={o.id}
                    checked={picked}
                    // At least one thing stays picked.
                    disabled={picked && draft.objects.length === 1}
                    onChange={(on) =>
                      set({
                        objects: on
                          ? ids.filter((id) => id === o.id || draft.objects.includes(id))
                          : (draft.objects as string[]).filter((id) => id !== o.id),
                      })
                    }
                  >
                    {o.label}
                  </Check>
                );
              })}
            </div>
          </>
        )}
        <span>is inside</span>
        <input
          aria-label="Rule name"
          placeholder="Zone name"
          maxLength={40}
          value={draft.label}
          onChange={(e) => set({ label: e.target.value })}
        />
        <span>turn on</span>
        <Select
          aria-label="Rule light"
          value={draft.entityId}
          onChange={(entityId) => set({ entityId })}
          options={[
            ...entities.map((l) => ({ value: l, label: l })),
            { value: '', label: 'nothing: tell Home Assistant only' },
          ]}
        />
        <span />
        <Check
          checked={draft.offWhenEmpty && Boolean(draft.entityId)}
          disabled={!draft.entityId}
          onChange={(offWhenEmpty) => set({ offWhenEmpty })}
        >
          and off again when it empties
        </Check>
      </div>
      {(!draft.rect || !draft.label.trim()) && (
        <p className="micro">
          {!draft.rect ? 'Draw the zone to save the rule.' : 'Name the zone to save the rule.'}
        </p>
      )}
      <div className="save-actions">
        <Button
          variant="primary"
          disabled={off || !draft.rect || !draft.label.trim()}
          onClick={() =>
            void call<DeskMemory>(
              'desk/rules/save',
              {
                rule: {
                  ...(draft.id ? { id: draft.id } : {}),
                  ...(draft.fixtureId && draft.entityId ? { fixtureId: draft.fixtureId } : {}),
                  label: draft.label.trim(),
                  objects: draft.objects,
                  entityId: draft.entityId || null,
                  ...(draft.offWhenEmpty && draft.entityId ? { offWhenEmpty: true } : {}),
                  rect: draft.rect,
                  ...(draft.onSurface ? { onSurface: draft.onSurface } : {}),
                },
              },
              (m) => {
                lab.setMemory(m);
                lab.setMessage(
                  `${editing ? 'Updated' : 'Saved'} "${draft.label.trim()}". Check rules or track something to try it.`,
                );
                const saved = draft.id ?? m.rules?.at(-1)?.id;
                lab.select(saved ? { kind: 'rule', id: saved } : null);
              },
            )
          }
        >
          {editing ? 'Save changes' : 'Save rule'}
        </Button>
        <Button onClick={back}>Cancel</Button>
      </div>
      {!entities.length && (
        <ChooseDevicesLink why="No devices to turn on yet; without one, a rule only reports to Home Assistant." />
      )}
    </Panel>
  );
}

function body(lab: ReturnType<typeof useLab>, s: Selection | null) {
  const { progress, workScene } = lab;
  if (!s || !workScene || !progress.room) return <SetupPanel />;
  switch (s.kind) {
    case 'room':
      return <RoomPanel />;
    case 'view': {
      if (progress.view && progress.deskId) return <SurfacePanel id={progress.deskId} closeView />;
      const main = mainSurface(lab);
      return main ? <SurfacePanel id={main.surface.id} /> : <RoomPanel />;
    }
    case 'surface':
      return <SurfacePanel key={s.id} id={s.id} />;
    case 'add':
      return <AddPanel />;
    case 'suggested': {
      const o = lab.scene?.objects[s.index];
      return o ? <AddPanel key={s.index} concept={o} /> : <AddPanel />;
    }
    case 'object':
      return s.id === 'main' ? <MugPanel /> : <OtherPanel key={s.id} id={s.id} />;
    case 'rule':
      return s.id === 'main' ? <ZonePanel /> : <RulePanel key={s.id} id={s.id} />;
    case 'new-rule':
      return <NewRulePanel />;
    case 'fixture':
      return <FixturePanel key={s.id} id={s.id} />;
    case 'new-fixture':
      return <NewFixturePanel />;
    case 'lamp':
      return <LampPanel key={s.id} id={s.id} />;
    case 'built-in':
      return <BuiltInPanel key={s.id} id={s.id} />;
    case 'entity':
      return <EntityPanel key={s.id} id={s.id} />;
    case 'new-entity':
      return <NewEntityPanel />;
    case 'devices':
      return <DevicesPanel />;
  }
}

/** Properties and actions for whatever the outline has selected. */
export function Inspector() {
  const lab = useLab();
  return (
    <aside className="ws-inspector" aria-label="Inspector">
      {lab.selection && lab.progress.room && (
        <div className="pane-head">
          <Button variant="text" onClick={() => lab.select(null)}>
            ← Setup
          </Button>
        </div>
      )}
      {body(lab, lab.selection)}
    </aside>
  );
}
