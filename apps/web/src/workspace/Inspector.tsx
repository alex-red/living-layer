import { ThingStats } from './ThingStats';
import { ThingLayer } from './ThingLayer';
import { lazy, useEffect, useState, type ReactNode } from 'react';
import { useNow } from '../useNow';
import {
  MAX_OTHER_OBJECTS,
  OBSERVATION_MAX_AGE_MS,
  exposedEntityId,
  gpuTrackerLine,
  isMugConcept,
  keyFromName,
  objectById,
  ruleWho,
  MAIN_RULE,
  THING_ZONE,
  type DeskMemory,
  type ZoneStep,
  type ZoneActions,
  ruleActions,
  MOTION_ZONE,
  type EvidenceRun,
  type PlacementDecision,
  type SelectionShape,
  ILLUSTRATION_NOTE_MAX,
  mainZone,
  mugModel,
  mugOf,
  mugSighting,
  otherObjects,
  placedFixtures,
} from '@livinglayer/domain';
import { api } from '../api';
import { estimateLabel } from '../cost';
import { Glyph } from '../Glyph';
import { Button, Check, Field, NumberInput, Segmented, Select } from '../ui/controls';
import {
  useCalibration,
  useCamera,
  useDesk,
  useFeedback,
  useFixtures,
  useFollowState,
  useLabParts,
  useNavigation,
  useObservation,
  useProbes,
  useTracking,
  useView,
} from './LabContext';
import { useFollowStats, useFollowView } from './state/follow-store';
import { Ago, Cost, Details, Panel, useCall, useOlderThan } from './panel';
import { zoneDrawnOn } from './zoneDraw';
import { useStore } from './state/store';
import { useDragRect } from './state/view';
import { watchStore } from '../watch';
import { ScanFixtures } from './ScanFixtures';
import { BoxOnlyNote, LocalOutline } from './LocalOutline';
import { ChooseDevicesLink } from './ChooseDevicesLink';
import { ThingZoneLink } from './ThingZoneLink';
import { ZoneActionsEditor, actionsProblem } from './ZoneActions';
import { SavedZoneWatches, ZoneWatches, zoneThings } from './ZoneWatches';
import { Later } from '../Later';
import {
  mainSurface,
  roomLabel,
  selectionLabel,
  surfaceRows,
  theRoom,
  type LabRead,
} from './labels';
import { pinScene, viewLabel, type Selection } from './progress';
import { TRANSITION, centre, type Lab } from './useLabState';
import './inspector.css';
import './objects.css';

// The fixture, entity and Home Assistant panels load when first shown.
const FixturePanel = lazy(() =>
  import('./FixturePanel').then((m) => ({ default: m.FixturePanel })),
);
const NewFixturePanel = lazy(() =>
  import('./FixturePanel').then((m) => ({ default: m.NewFixturePanel })),
);
const NewMemberPanel = lazy(() =>
  import('./FixturePanel').then((m) => ({ default: m.NewMemberPanel })),
);
const LampPanel = lazy(() => import('./FixturePanel').then((m) => ({ default: m.LampPanel })));
const BuiltInPanel = lazy(() =>
  import('./FixturePanel').then((m) => ({ default: m.BuiltInPanel })),
);
const EntityPanel = lazy(() => import('./ExposePanel').then((m) => ({ default: m.EntityPanel })));
const NewEntityPanel = lazy(() =>
  import('./ExposePanel').then((m) => ({ default: m.NewEntityPanel })),
);
const DevicesPanel = lazy(() =>
  import('./DevicesPanel').then((m) => ({ default: m.DevicesPanel })),
);
const DesktopsPanel = lazy(() =>
  import('./DesktopsPanel').then((m) => ({ default: m.DesktopsPanel })),
);

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
/**
 * The zone's numbers while it is drawn. A drag on the photo shows here as it
 * moves (from `dragRectStore`), so only these fields render at its rate.
 */
function ZoneFields({
  draftZone,
  busy,
  setDraftZone,
}: {
  draftZone: Lab['draftZone'];
  busy: boolean;
  setDraftZone: Lab['setDraftZone'];
}) {
  const zone = useDragRect('zone') ?? draftZone;
  return (
    <div className="zone-fields">
      {(['x', 'y', 'width', 'height'] as const).map((key) => (
        <label key={key}>
          Zone {key} %
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={Math.round(zone[key] * 100)}
            disabled={busy}
            onChange={(e) =>
              // A rectangle edited in the frame is no longer the one drawn in the room.
              setDraftZone(({ onSurface: _, ...z }) => ({
                ...z,
                [key]: Number(e.target.value) / 100,
              }))
            }
          />
        </label>
      ))}
    </div>
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
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
    useProbes(),
  );
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
  const others = otherObjects(memory) ?? [];
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
                        const added = otherObjects(r.memory)?.at(-1);
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

/** With nothing selected: where to pick something. Setup's steps are in the outline. */
function NothingSelected() {
  return (
    <Panel
      tiny="INSPECTOR"
      title="Nothing selected"
      status="Pick a thing, a zone or a surface in the outline or on the stage."
      tone="seen"
    />
  );
}

/**
 * Draw a photographed room as a clean isometric picture: Muse Image redraws
 * the current photo, SAM finds the desk in it, and the room shows as that
 * picture with the mug and zones on its desk.
 */
function PictureControls({ view = 'room' }: { view?: 'room' | 'desk' }) {
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useCamera(), useFixtures());
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
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useFixtures());
  const { memory, mode, busy } = lab;
  const pinScene = memory?.surface?.scene;
  const count = placedFixtures(memory).filter((f) => f.scene === pinScene).length;
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
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
    useCalibration(),
  );
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
      <LayoutToggle primary disabled={!workScene} />
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
            { value: 'home', label: 'Home' },
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

/** Open the layout editor in the canvas, in the room or the view it shows, or close it. */
function LayoutToggle({ primary = false, disabled = false }) {
  const lab = useLabParts(useView(), useNavigation());
  return lab.isoPanel === 'scene' && lab.stageView !== 'photo' ? (
    <Button onClick={() => lab.setIsoPanel('room')}>Done editing</Button>
  ) : (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      disabled={disabled}
      onClick={lab.editLayout}
    >
      Edit layout
    </Button>
  );
}
/** Pin a surface to the camera frame: the bridge between the photo and the iso room. */
function SurfacePanel({ id, closeView }: { id: string; closeView?: boolean }) {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
    useCalibration(),
    useProbes(),
    useFixtures(),
  );
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
  // A close view's scene, which one look can scan and follow.
  const deskScene = closeView && progress.view ? pinScene(progress.view) : null;
  return (
    <Panel
      tiny={
        closeView ? `CLOSE VIEW · IN ${theRoom(progress.room, memory).toUpperCase()}` : 'SURFACE'
      }
      title={title}
      status={
        demoPin
          ? `The demo ${label} is pinned for you.`
          : row.pinned
            ? 'Its corners are pinned.'
            : needPhoto
              ? `Add a close photo of the ${label}, then pin its four corners.`
              : `Pin the ${label} to place objects on it.`
      }
      tone={row.pinned ? 'ok' : 'seen'}
    >
      {row.pinned && deskScene && (
        <>
          <Button
            variant="primary"
            disabled={Boolean(busy) || (mode === 'live' && !image && !lab.camera)}
            onClick={() => void lab.findOnDesk(deskScene)}
          >
            {busy === 'scan'
              ? 'Scanning…'
              : busy === 'follow-desk'
                ? 'Following…'
                : 'Find what’s on the desk'}
            <Glyph type="arrow" />
          </Button>
          <p className="micro">
            Finds each thing on the desk, adds what the room hasn’t got, and follows them.
          </p>
          {mode === 'live' && <Cost>1 Spark and 1 SAM call for the scan; following is free.</Cost>}
        </>
      )}
      {row.pinned ? (
        <Button
          variant={deskScene ? 'secondary' : 'primary'}
          onClick={() =>
            lab.select(mugOf(memory) ? { kind: 'object', id: 'main' } : { kind: 'add' })
          }
        >
          {mugOf(memory)
            ? `Open ${mugOf(memory)!.label}`
            : deskScene
              ? 'Add one by hand'
              : 'Find objects'}{' '}
          <Glyph type="arrow" />
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
          Shared with {theRoom(progress.room, memory)}: what you place here shows there too.
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
        <LayoutToggle />
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
      {/* How far the marks were off is for whoever is checking, in the line's title. */}
      <p
        className="micro"
        title={
          memory?.camera
            ? `Marks off by ${memory.camera.error.toFixed(1)} px on average`
            : undefined
        }
      >
        {memory?.camera
          ? `Camera calibrated${memory.camera.moved ? ', but it has moved: zones pause until you calibrate again' : ''}.`
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
            onClick={() => void api('room/forget', { mode }).then((m) => lab.setMemory(m))}
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
            disabled={Boolean(busy) || !mugOf(memory)}
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
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
    useProbes(),
  );
  const { mode, image, camera, canVision, busy, status, concept, scene, trackingAi } = lab;
  const needPhoto = mode === 'live' && !image && !camera;
  // Without AI, what it is comes from the name and where it is from a box drawn round it.
  const outline = (name: string, drawn: { shape: SelectionShape; held: string | null }) => {
    lab.setConcept(name);
    void lab.execute('segment', name, drawn);
  };
  const drawing = lab.outlining?.target === 'object' ? lab.outlining : null;
  return (
    <Panel
      tiny={preset ? 'SUGGESTED BY SPARK' : 'ADD AN OBJECT'}
      title={preset ? preset.label : 'Find an object'}
      status={
        preset
          ? `${preset.appearance}. Find its outline, then confirm it.`
          : needPhoto
            ? 'Add a photo of the desk first: start the camera, or upload one.'
            : !trackingAi
              ? 'Name what it is, then draw round it on the picture; it is outlined on this machine.'
              : camera
                ? 'Name what to look for; SAM outlines every match the camera shows.'
                : 'Name what to look for; SAM outlines every match in this frame.'
      }
      tone={needPhoto ? 'unsure' : 'seen'}
    >
      {preset && !trackingAi ? (
        <LocalOutline
          target="object"
          working={busy === 'segment'}
          onOutline={(d) => outline(preset.category, d)}
        />
      ) : preset ? (
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
                if (e.key !== 'Enter' || busy || !concept.trim()) return;
                if (trackingAi) {
                  if (canVision) void lab.execute('segment');
                } else if (drawing?.shape)
                  outline(concept.trim(), { shape: drawing.shape, held: drawing.held });
              }}
            />
            <span>{trackingAi || drawing?.shape ? '↵ TO RUN' : 'NAME IT'}</span>
          </div>
          {trackingAi ? (
            <Button
              variant="primary"
              disabled={!canVision || !concept.trim()}
              onClick={() => void lab.execute('segment')}
            >
              {busy === 'segment' ? 'Decoding…' : 'Segment object'}
              <Glyph type="arrow" />
            </Button>
          ) : (
            <LocalOutline
              target="object"
              disabled={!concept.trim()}
              working={busy === 'segment'}
              onOutline={(d) => outline(concept.trim(), d)}
            />
          )}
        </>
      )}
      {status && trackingAi && <Cost>{estimateLabel(status.meta.estimates.segment, 'image')}</Cost>}
      <MaskResults />
      {!preset && !trackingAi && (
        <p className="micro">
          Discovering objects and testing for false matches ask Spark and SAM: let tracking call AI,
          under the spending readout at the top, to use them.
        </p>
      )}
      {!preset && trackingAi && (
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
      {trackingAi && (
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
      )}
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
 * and judges its zones whether or not a tab is open, on this machine unless
 * tracking may call SAM.
 */
function WatchControl() {
  const lab = useLabParts(useView(), useDesk(), useTracking());
  const { watching, canWatch, mode, trackingAi } = lab;
  // The watcher's counts change with each frame it reads: this alone renders for them.
  const watch = useStore(watchStore);
  const stats =
    watch &&
    `${watch.frames} frame${watch.frames === 1 ? '' : 's'} · ${watch.ai ? `${watch.checks} SAM check${watch.checks === 1 ? '' : 's'}` : 'local only, no SAM calls'}${watch.appearance ? ` · ${watch.refinds} found by appearance` : ''}${watch.gpu ? ` · ${gpuTrackerLine(watch.gpu)}` : ''}`;
  // Followed, but close to a look-alike while one moved: which is which waits for a person.
  const entangled = watching && watch ? watch.things.filter((t) => t.status === 'entangled') : [];
  return (
    <>
      <Button
        disabled={!watching && !canWatch}
        onClick={() => void lab.toggleWatch()}
        title={
          watching
            ? 'Pause watching until the server starts again: it watches by default'
            : 'The server follows every confirmed thing in the camera and judges its zones, with or without this tab'
        }
      >
        {watching ? 'Pause watching' : 'Watch on the server'}
      </Button>
      <p className="micro" title={watching && watch ? `${stats}. ${watch.note}` : undefined}>
        {watching && watch
          ? `${WATCH_STATE[watch.state]}${watch.camera ? ` ${watch.camera.name}` : ''}, with or without this tab.`
          : canWatch
            ? `Follows everything confirmed with no tab open, on this machine${trackingAi ? ', asking SAM only for a thing it has lost' : ''}${mode === 'live' ? '' : ' (here, each move is a frame)'}.`
            : 'Needs a network camera. Follow it in this tab instead.'}
      </p>
      {entangled.length > 0 && (
        <p className="micro">
          Which one? {entangled.map((t) => t.label).join(', ')} came close to a look-alike, so which
          is which isn’t sure and {entangled.length === 1 ? 'its' : 'their'} zones wait. Find it
          again and confirm it by hand to tell them apart.
        </p>
      )}
    </>
  );
}

/** The by-hand steps: folded away while the camera watches, since it finds the thing itself. */
function ByHand({ folded, children }: { folded: boolean; children: ReactNode }) {
  return folded ? <Details summary="Find it by hand">{children}</Details> : <>{children}</>;
}

function MugPanel() {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useFollowState(),
    useCamera(),
    useObservation(),
    useTracking(),
    useNavigation(),
    useProbes(),
  );
  const { memory, mode, camera, busy, status, follow, localZone, trackingAi, watching } = lab;
  const { currentObservation, sightings } = lab;
  // Turns once, when the sighting expires; the seconds tick in `Ago` and `Freshness` alone.
  const observationStale = useOlderThan(mugSighting(memory)?.observedAt, OBSERVATION_MAX_AGE_MS);
  if (!memory || !mugOf(memory))
    return (
      <Panel
        tiny="THING · MUG"
        title="No mug yet"
        status="Find the mug and confirm its outline first."
        tone="unsure"
      >
        <Button variant="primary" onClick={() => lab.select({ kind: 'add' })}>
          Find the mug
        </Button>
      </Panel>
    );
  const o = mugSighting(memory);
  const seen = o && <Ago at={o.observedAt} />;
  return (
    <Panel
      tiny="THING · MUG"
      title={mugOf(memory)!.label}
      status={
        watching ? (
          'The camera is watching it.'
        ) : !o ? (
          'Remembered, but not seen yet. Track it in a frame.'
        ) : currentObservation ? (
          <>Confirmed in this frame · seen {seen}.</>
        ) : observationStale ? (
          <>Seen {seen}, so it may have moved. Track it in a new frame.</>
        ) : (
          <>Seen {seen} in an earlier frame. Track it in this frame to continue.</>
        )
      }
      tone={watching || currentObservation ? 'chosen' : observationStale ? 'unsure' : 'seen'}
      aside={o && !watching && <Freshness observedAt={o.observedAt} />}
    >
      {watching && <WatchControl />}
      <ByHand folded={watching}>
        {trackingAi ? (
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
        ) : (
          <LocalOutline
            target="mug"
            disabled={follow || !o}
            working={busy === 'track'}
            onOutline={(d) => void lab.track({ outline: d })}
          />
        )}
        <p className="micro">
          {!trackingAi
            ? 'Draw round the mug where it is now to find it in this frame, on this machine.'
            : mode === 'demo'
              ? 'Move the mug with the buttons under the canvas, then track it.'
              : 'Move the mug, start the camera, then capture & track.'}
        </p>
        <BoxOnlyNote id={mugOf(memory)!.id} seen={o} />
        {status && trackingAi && (
          <Cost>{estimateLabel(status.meta.estimates.segment, 'track')}</Cost>
        )}
      </ByHand>
      {!watching && <WatchControl />}
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
            {follow ? (
              <FollowSummary localZone={Boolean(localZone)} />
            ) : currentObservation ? (
              'Follows the mug in this tab; SAM confirms each zone crossing.'
            ) : (
              'Track the mug in this frame first.'
            )}
          </p>
        </>
      )}
      <div className="insp-links">
        <Button variant="text" onClick={() => lab.select({ kind: 'rule', id: 'main' })}>
          {mainZone(memory) ? 'Zone and light' : 'Draw its zone'} →
        </Button>
        <Button variant="text" disabled={Boolean(busy)} onClick={() => lab.openModel(undefined)}>
          Edit model {mugModel(memory) ? '· fitted' : ''} →
        </Button>
      </div>
      <ThingLayer thing={mugOf(memory)!} disabled={Boolean(busy)} />
      <ThingStats id={mugOf(memory)!.id} label={mugOf(memory)!.label} type="mug" />
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
  const lab = useLabParts(
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
    useProbes(),
  );
  const { memory, segmentation, segmentRunId, canVision } = lab;
  const { call, off } = useCall();
  const o = otherObjects(memory)?.find((x) => x.id === id);
  if (!o) return <NothingSelected />;
  const canTrack =
    segmentation &&
    segmentRunId &&
    segmentRunId !== o.observation?.segmentRunId &&
    segmentation.concept.trim().toLowerCase() === o.concept.trim().toLowerCase();
  return (
    <Panel
      tiny={`THING · ${o.concept.toUpperCase()}`}
      title={o.label}
      status={
        o.observation ? (
          <>
            Seen <Ago at={o.observation.observedAt} /> · found as “{o.concept}”.
          </>
        ) : (
          `Remembered · found as “${o.concept}”.`
        )
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
      ) : lab.trackingAi ? (
        <Button
          variant="primary"
          disabled={!canVision}
          onClick={() => void lab.execute('segment', o.concept)}
        >
          Find it in this frame
        </Button>
      ) : (
        <LocalOutline
          target={`object ${o.id}`}
          working={lab.busy === 'segment'}
          onOutline={(d) => void lab.execute('segment', o.concept, d)}
        />
      )}
      <BoxOnlyNote id={o.id} seen={o.observation} />
      <p className="micro">
        {canTrack
          ? `The newest outlines are of “${o.concept}”. Match one to the ${o.label}.`
          : lab.trackingAi
            ? 'Outline it in this frame, then track it.'
            : 'Draw round it to outline it on this machine, then track it.'}
      </p>
      <div className="insp-links">
        {lab.entities.length > 0 && o.observation && (
          <Button variant="text" onClick={() => lab.startRule(o.id)}>
            Add a rule for it →
          </Button>
        )}
        {o.observation && <ThingZoneLink id={o.id} />}
        <Button variant="text" disabled={off} onClick={() => lab.openModel(o.id)}>
          Edit model →
        </Button>
      </div>
      <ThingStats id={o.id} label={o.label} type={o.concept} />
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
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useCalibration());
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
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useObservation(),
    useNavigation(),
    useProbes(),
  );
  const { memory, mode, busy, drawing, draftZone, currentObservation, zoneObservation, lampReady } =
    lab;
  if (!memory || !mugOf(memory)) {
    const saved = mainZone(memory);
    return (
      <Panel
        tiny="ZONE"
        title={saved?.label ?? 'Main zone'}
        status={
          saved
            ? 'Its zone is saved. Remember the mug to draw it again.'
            : 'Remember the mug first; its zone is drawn on a frame it was seen in.'
        }
        tone="unsure"
      >
        <Button variant="primary" onClick={() => lab.select({ kind: 'add' })}>
          Find the mug
        </Button>
        {saved && <DeleteMainZone id={saved.id} label={saved.label} />}
      </Panel>
    );
  }
  const d = memory.lastDecision?.output;
  const rule = memory.rules?.find((r) => r.id === MAIN_RULE);
  // What it watches: anything seen, unless set to other things.
  const who = rule ? ruleWho(memory, rule) : 'anything';
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  const status = !mainZone(memory)
    ? zoneObservation
      ? 'Draw the zone the mug should be in.'
      : 'Track the mug in this frame, then draw its zone.'
    : !d
      ? `Zone saved. Check where ${who} is to try the rule.`
      : d.decision === 'inside'
        ? d.action === 'confirmed'
          ? `${Who} is in the zone. Its steps ran${mode === 'demo' ? ' on virtual devices' : ''}.`
          : d.action === 'pending'
            ? `${Who} is in the zone. Running its steps…`
            : `${Who} is still in the zone. Its steps run only on entering.`
        : d.decision === 'outside'
          ? `${Who} is outside the zone. Nothing to do.`
          : `Blocked: ${d.reason}`;
  const main = mainZone(memory);
  const mug = mugOf(memory)!;
  return (
    <Panel
      tiny="ZONE"
      title={main?.label ?? 'Main zone'}
      status={status}
      tone={
        !d ? 'seen' : d.decision === 'blocked' ? 'unsure' : d.action === 'confirmed' ? 'warm' : 'ok'
      }
    >
      {main ? (
        <div className="zone-form">
          <div className="zone-section">
            <span className="tiny">Name</span>
            <ZoneName id={main.id} label={main.label} />
          </div>
          {rule && (
            <div className="zone-section">
              <span className="tiny">Watches</span>
              <SavedZoneWatches rule={rule} />
            </div>
          )}
          <SavedZoneActions ruleId={main.id} who={who} />
        </div>
      ) : (
        <p className="rule-sentence">
          Draw where the <strong>{mug.label}</strong> belongs; then choose what happens as it
          arrives and leaves.
        </p>
      )}
      <LastRun decision={memory.rules?.find((r) => r.id === main?.id)?.lastDecision?.output} />
      <CameraMoved />
      {!drawing && (
        <Button
          disabled={Boolean(busy) || !zoneObservation}
          onClick={() => {
            const m = mainZone(memory);
            lab.setDraftZone(
              m
                ? { ...m.rect, ...(m.onSurface ? { onSurface: m.onSurface } : {}) }
                : { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
            );
            lab.setDrawing(true);
          }}
        >
          {mainZone(memory) ? 'Edit zone' : 'Draw zone'}
        </Button>
      )}
      {drawing && (
        <div className="zone-editor">
          <p className="micro">
            Drag a rectangle on the photo or the iso surface, or enter percentages.
          </p>
          <ZoneFields draftZone={draftZone} busy={Boolean(busy)} setDraftZone={lab.setDraftZone} />
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
          !mainZone(memory) ||
          (mode === 'live' && !lampReady)
        }
        onClick={() =>
          void lab.deskAction('verify', {
            observationId: currentObservation?.id,
            zoneId: mainZone(memory)?.id,
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
      {!currentObservation && mainZone(memory) && (
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
          {!mainZone(memory)
            ? 'No zone saved yet.'
            : memory.fixedCamera
              ? 'The zone carries over to new frames of this size.'
              : 'The zone applies only to the frame it was drawn on.'}{' '}
          Sightings expire after 5 minutes.
        </p>
      </Details>
      {main && !drawing && <DeleteMainZone id={main.id} label={main.label} />}
    </Panel>
  );
}

/** Deleting the main zone, with or without a mug to draw it on. */
function DeleteMainZone({ id, label }: { id: string; label: string }) {
  const lab = useLabParts(useFeedback(), useDesk(), useNavigation());
  const { call, off } = useCall();
  return (
    <Details summary="Delete">
      <Button
        variant="danger"
        disabled={off}
        onClick={() =>
          void call<DeskMemory>('desk/rules/delete', { ruleId: id }, (m) => {
            lab.setMemory(m);
            lab.setMessage(`Removed "${label}".`);
            lab.select(null);
          })
        }
      >
        Delete “{label}”
      </Button>
    </Details>
  );
}

/** A zone's name, renamed in place: Enter or the button saves, Escape puts it back. */
function ZoneName({ id, label }: { id: string; label: string }) {
  const lab = useLabParts(useFeedback(), useDesk());
  const { call, off } = useCall();
  const [name, setName] = useState(label);
  useEffect(() => setName(label), [label]);
  const next = name.trim();
  const changed = Boolean(next) && next !== label;
  const save = () =>
    changed &&
    void call<DeskMemory>('desk/rules/options', { ruleId: id, label: next }, (m) => {
      lab.setMemory(m, false);
      lab.setMessage(`Renamed the zone to "${next}".`);
    });
  return (
    <form
      className="zone-rename"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        className="zone-name"
        aria-label="Zone name"
        maxLength={40}
        disabled={off}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setName(label)}
      />
      {changed && (
        <Button type="submit" variant="primary" size="sm" disabled={off}>
          Rename
        </Button>
      )}
    </form>
  );
}

/**
 * A saved zone's steps, edited where they are shown; Save appears once
 * something changed. The main zone's old empty entity shows as the main lamp.
 */
function SavedZoneActions({ ruleId, who }: { ruleId: string; who: string }) {
  const lab = useLabParts(useFeedback(), useDesk());
  const { memory, entities, lights } = lab;
  const { call, off } = useCall();
  const rule = memory?.rules?.find((r) => r.id === ruleId);
  const saved = rule ? ruleActions(rule) : { onEnter: [], onLeave: [] };
  const mainLamp = lights[0] ?? '';
  const shown: ZoneActions = {
    onEnter: withLamp(saved.onEnter, mainLamp),
    onLeave: withLamp(saved.onLeave, mainLamp),
  };
  const shownKey = JSON.stringify(shown);
  const [draft, setDraft] = useState(shown);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `shownKey` stands for the value's content
  useEffect(() => setDraft(shown), [shownKey]);
  if (!rule || !memory) return null;
  const things = rule.motion
    ? []
    : zoneThings(memory).filter((t) => rule.objects === 'any' || rule.objects.includes(t.id));
  const dirty = JSON.stringify(draft) !== shownKey;
  const problem = actionsProblem(draft, rule.motion ? [] : rule.objects);
  return (
    <div className="zone-section">
      <span className="tiny">Actions</span>
      <ZoneActionsEditor
        value={draft}
        onChange={setDraft}
        entities={entities}
        things={things}
        disabled={off}
        who={who}
        {...(rule.motion ? { motion: rule.motion } : {})}
      />
      {dirty && (
        <div className="save-actions">
          {problem && <p className="micro">{problem}</p>}
          <Button
            variant="primary"
            disabled={off || Boolean(problem)}
            onClick={() =>
              void call<DeskMemory>('desk/rules/options', { ruleId, actions: draft }, (m) => {
                lab.setMemory(m, false);
                lab.setMessage(`Saved what "${rule.label}" does.`);
              })
            }
          >
            Save actions
          </Button>
          <Button onClick={() => setDraft(shown)}>Undo changes</Button>
        </div>
      )}
    </div>
  );
}
/** Steps with the main zone's empty entity named as the main lamp, nested ones too. */
function withLamp(steps: ZoneStep[], lamp: string): ZoneStep[] {
  return steps.map((s) =>
    s.kind === 'switch'
      ? { ...s, entityId: s.entityId || lamp }
      : s.kind === 'if'
        ? { ...s, then: withLamp(s.then, lamp), else: withLamp(s.else, lamp) }
        : s.kind === 'repeat'
          ? { ...s, steps: withLamp(s.steps, lamp) }
          : s,
  );
}

/** What a zone's last change ran, a line a step. */
function LastRun({ decision }: { decision: PlacementDecision | undefined }) {
  if (!decision?.steps?.length) return null;
  return (
    <Details summary={decision.action === 'pending' ? 'Running now' : 'Last run'}>
      <ol className="za-log">
        {decision.steps.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>
    </Details>
  );
}

function RulePanel({ id }: { id: string }) {
  const lab = useLabParts(useFeedback(), useDesk(), useNavigation());
  const { memory } = lab;
  const { call, off } = useCall();
  const r = memory?.rules?.find((x) => x.id === id);
  if (!r) return <NothingSelected />;
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
      tiny="ZONE"
      title={r.label}
      status={
        !d
          ? r.motion
            ? 'No motion seen yet. It is watched on the camera while watching is on.'
            : 'Not checked yet. Track the object or check the zones.'
          : d.decision === 'inside'
            ? `${r.motion ? 'Motion now' : `Occupied (${inside ?? 'something'})`}.${d.action === 'pending' ? ' Running its steps…' : ''}`
            : d.decision === 'outside'
              ? `${r.motion ? 'Still' : 'Empty'}.${d.action === 'pending' ? ' Running its steps…' : ''}`
              : `Blocked: ${d.reason}`
      }
      tone={
        !d ? 'seen' : d.decision === 'blocked' ? 'unsure' : d.action === 'confirmed' ? 'warm' : 'ok'
      }
    >
      <div className="zone-form">
        <div className="zone-section">
          <span className="tiny">Name</span>
          <ZoneName id={r.id} label={r.label} />
        </div>
        <div className="zone-section">
          <span className="tiny">Watches</span>
          {r.motion ? (
            <div className="zone-area drawn">
              <span>
                Motion in {Math.round(r.motion.share * 100)}% of it · stops after {r.motion.quietS}{' '}
                s
              </span>
              <Button variant="text" size="sm" disabled={off} onClick={() => lab.editRule(r.id)}>
                Redraw or change →
              </Button>
            </div>
          ) : (
            <>
              <SavedZoneWatches rule={r} exclude={r.anchor ? [r.anchor.thingId] : []} />
              <Button variant="text" size="sm" disabled={off} onClick={() => lab.editRule(r.id)}>
                {r.anchor ? 'Change its margin →' : 'Redraw it →'}
              </Button>
            </>
          )}
        </div>
        {r.anchor && (
          <div className="zone-section">
            <span className="tiny">Area</span>
            <div className="zone-area drawn">
              The {memory?.fixtures?.find((f) => f.id === r.anchor!.thingId)?.label ?? 'thing'} and{' '}
              {r.anchor.padCm} cm round it, wherever it is
            </div>
          </div>
        )}
        <SavedZoneActions ruleId={r.id} who={who} />
      </div>
      <LastRun decision={d} />
      <CameraMoved />
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
      {/* A motion zone is judged on the watched camera's frames, not by a check. */}
      {!r.motion && (
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
          Check zones
        </Button>
      )}
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

/**
 * A zone set up or changed in one place: its name, what it watches, the area
 * dragged on the room, and what it does as something enters and as it empties.
 */
function NewRulePanel() {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useNavigation(),
  );
  const { memory, ruleDraft: draft, entities } = lab;
  const { call, off } = useCall();
  if (!draft) return <NothingSelected />;
  // The thing a zone is can't stand in it.
  const anchor = draft.anchor;
  const things = zoneThings(memory).filter((t) => t.id !== anchor?.thingId);
  const anchorLabel = anchor
    ? (memory?.fixtures?.find((f) => f.id === anchor.thingId)?.label ?? 'thing')
    : null;
  const set = (patch: Partial<typeof draft>) => lab.setRuleDraft({ ...draft, ...patch });
  const watched =
    draft.objects === 'any' ? things : things.filter((t) => draft.objects.includes(t.id));
  const who = memory ? ruleWho(memory, draft) : 'something';
  const editing = Boolean(draft.id);
  const back = () => lab.select(draft.id ? { kind: 'rule', id: draft.id } : null);
  const { motion } = draft;
  /** Thing zone or motion zone; the area is drawn again, on the room or on the picture. */
  const setType = (type: 'things' | 'motion') => {
    const { motion: _, onSurface: __, ...rest } = draft;
    if (type === 'motion') {
      lab.setRuleDraft({
        ...rest,
        objects: 'any',
        motion: { share: MOTION_ZONE.share, quietS: MOTION_ZONE.quietS },
        rect: null,
      });
      if (lab.stageView === 'iso') lab.setStageView('split');
    } else lab.setRuleDraft({ ...rest, rect: null });
  };
  const problem = !draft.label.trim()
    ? 'Name the zone to save it.'
    : !draft.rect && !anchor
      ? 'Draw the zone to save it.'
      : actionsProblem(draft.actions, motion ? [] : draft.objects);
  const onPicture = zoneDrawnOn(draft, lab.camera || lab.mode === 'demo') === 'picture';
  const where = onPicture ? 'the camera picture' : 'the room';
  return (
    <Panel
      tiny={editing ? 'EDIT ZONE' : 'NEW ZONE'}
      title={draft.label.trim() || 'New zone'}
      status={
        anchor
          ? `The ${anchorLabel}: the zone goes wherever it does.`
          : draft.rect
            ? `Drawn. Drag again on ${where} to redraw it.`
            : motion
              ? 'Drag a rectangle on the camera picture around what should be watched for motion.'
              : onPicture
                ? 'Drag a rectangle on the camera picture to draw the zone.'
                : mainSurface(lab) || lab.progress.pinned
                  ? 'Drag a rectangle on the room to draw the zone.'
                  : 'Pin a surface first, so the zone can be drawn on it.'
      }
      tone={draft.rect || anchor ? 'chosen' : 'seen'}
    >
      <div className="zone-form">
        <div className="zone-section">
          <span className="tiny">Name</span>
          <input
            className="zone-name"
            aria-label="Zone name"
            placeholder="Desk, Tray, Sofa…"
            maxLength={40}
            value={draft.label}
            onChange={(e) => set({ label: e.target.value })}
          />
        </div>
        <div className="zone-section">
          <span className="tiny">Type</span>
          <Segmented
            label="Zone type"
            value={motion ? 'motion' : 'things'}
            onChange={setType}
            options={[
              { value: 'things', label: 'Things inside', title: 'Things the camera follows' },
              { value: 'motion', label: 'Motion', title: 'Anything moving in it' },
            ]}
          />
        </div>
        {motion ? (
          <div className="zone-section">
            <span className="tiny">Motion</span>
            <label className="zone-slider">
              <span>Moves in at least</span>
              <input
                type="range"
                aria-label="How much must move"
                min={MOTION_ZONE.minShare * 100}
                max={30}
                value={Math.round(motion.share * 100)}
                onChange={(e) =>
                  set({ motion: { ...motion, share: Number(e.target.value) / 100 } })
                }
              />
              <output>{Math.round(motion.share * 100)}% of it</output>
            </label>
            <div className="za-row">
              <span className="za-word">Stops after</span>
              <NumberInput
                aria-label="Seconds still before it stops"
                className="za-num"
                min={1}
                max={MOTION_ZONE.maxQuietS}
                value={motion.quietS}
                onChange={(quietS) => set({ motion: { ...motion, quietS } })}
              />
              <span className="za-word">s still</span>
            </div>
            <p className="micro">
              Lower is more sensitive. A light switching across the whole picture isn’t motion.
            </p>
          </div>
        ) : (
          <div className="zone-section">
            <span className="tiny">Watches</span>
            <ZoneWatches
              value={{ objects: draft.objects, ...(draft.match ? { match: draft.match } : {}) }}
              onChange={({ objects, match }) => {
                const { match: _, ...rest } = draft;
                lab.setRuleDraft({ ...rest, objects, ...(match ? { match } : {}) });
              }}
              things={things}
              memory={memory}
            />
          </div>
        )}
        <div className="zone-section">
          <span className="tiny">Area</span>
          {anchor ? (
            <>
              <label className="zone-area drawn">
                <span>The {anchorLabel}, and</span>
                <input
                  type="number"
                  aria-label="Margin round it, cm"
                  min={0}
                  max={THING_ZONE.maxPadCm}
                  step={0.5}
                  value={anchor.padCm}
                  onChange={(e) => {
                    const padCm = Number(e.target.value);
                    if (Number.isFinite(padCm))
                      set({
                        anchor: {
                          ...anchor,
                          padCm: Math.min(Math.max(padCm, 0), THING_ZONE.maxPadCm),
                        },
                      });
                  }}
                />
                <span>cm round it</span>
              </label>
              <p className="micro">
                Something counts as on it while it stands over the {anchorLabel} or this close to
                its edge. Hidden under what stands on it, it keeps its last place.
              </p>
            </>
          ) : (
            <div className={`zone-area ${draft.rect ? 'drawn' : ''}`}>
              {draft.rect
                ? `${Math.round(draft.rect.width * 100)} × ${Math.round(draft.rect.height * 100)}% of the frame`
                : `Not drawn yet: drag on ${motion ? 'the camera picture' : 'the room view'}`}
            </div>
          )}
        </div>
        <div className="zone-section">
          <span className="tiny">Actions</span>
          <ZoneActionsEditor
            value={draft.actions}
            onChange={(actions) => set({ actions })}
            entities={entities}
            things={motion ? [] : watched}
            who={who}
            {...(motion ? { motion } : {})}
          />
        </div>
        {problem && <p className="micro">{problem}</p>}
        <div className="save-actions">
          <Button
            variant="primary"
            disabled={off || Boolean(problem)}
            onClick={() =>
              void call<DeskMemory>(
                'desk/rules/save',
                {
                  rule: {
                    ...(draft.id ? { id: draft.id } : {}),
                    label: draft.label.trim(),
                    objects: motion ? 'any' : draft.objects,
                    ...(!motion && draft.match ? { match: draft.match } : {}),
                    entityId: null,
                    actions: draft.actions,
                    ...(motion ? { motion } : {}),
                    ...(anchor
                      ? { anchor }
                      : {
                          rect: draft.rect!,
                          ...(draft.onSurface ? { onSurface: draft.onSurface } : {}),
                        }),
                  },
                },
                (m) => {
                  lab.setMemory(m);
                  lab.setMessage(
                    `${editing ? 'Updated' : 'Saved'} "${draft.label.trim()}". Check zones or track something to try it.`,
                  );
                  const saved = draft.id ?? m.rules?.at(-1)?.id;
                  lab.select(saved ? { kind: 'rule', id: saved } : null);
                },
              )
            }
          >
            {editing ? 'Save changes' : 'Save zone'}
          </Button>
          <Button onClick={back}>Cancel</Button>
        </div>
      </div>
      {!entities.length && (
        <ChooseDevicesLink why="No devices to switch yet; without one, a zone only reports to Home Assistant." />
      )}
    </Panel>
  );
}

function body(lab: LabRead & Pick<Lab, 'workScene'>, s: Selection | null) {
  const { progress, workScene } = lab;
  if (!s || !workScene || !progress.room) return <NothingSelected />;
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
      return (
        <Later>
          <FixturePanel key={s.id} id={s.id} />
        </Later>
      );
    case 'new-fixture':
      return (
        <Later>
          <NewFixturePanel />
        </Later>
      );
    case 'new-member':
      return (
        <Later>
          <NewMemberPanel key={s.member} member={s.member} />
        </Later>
      );
    case 'lamp':
      return (
        <Later>
          <LampPanel key={s.id} id={s.id} />
        </Later>
      );
    case 'built-in':
      return (
        <Later>
          <BuiltInPanel key={s.id} id={s.id} />
        </Later>
      );
    case 'entity':
      return (
        <Later>
          <EntityPanel key={s.id} id={s.id} />
        </Later>
      );
    case 'new-entity':
      return (
        <Later>
          <NewEntityPanel />
        </Later>
      );
    case 'devices':
      return (
        <Later>
          <DevicesPanel />
        </Later>
      );
    case 'desktops':
      return (
        <Later>
          <DesktopsPanel />
        </Later>
      );
  }
}

/** Properties and actions for whatever the outline has selected. */
export function Inspector() {
  const lab = useLabParts(useView(), useDesk(), useCamera(), useObservation(), useNavigation());
  // Back to the view this one was opened from, or closed when there is none.
  const back = lab.backTrail.at(-1) ?? null;
  return (
    <aside className="ws-inspector" aria-label="Inspector">
      {lab.selection && lab.progress.room && (
        <div className="pane-head">
          <Button variant="text" onClick={() => lab.select(back)}>
            {back ? `← ${selectionLabel(lab, back)}` : '× Close'}
          </Button>
        </div>
      )}
      {body(lab, lab.selection)}
    </aside>
  );
}

/** The local follower's tally; it renders at the follower's rate so the rest of the inspector need not. */
function FollowSummary({ localZone }: { localZone: boolean }) {
  const stats = useFollowStats();
  const view = useFollowView();
  return (
    <>
      {`${stats.frames} local step${stats.frames === 1 ? '' : 's'} · ${stats.checks} SAM check${stats.checks === 1 ? '' : 's'}${view ? ` · match ${view.track.score.toFixed(2)}` : ''}${localZone ? '' : ' · no zone to watch: save one and mark the camera fixed'}`}
    </>
  );
}
