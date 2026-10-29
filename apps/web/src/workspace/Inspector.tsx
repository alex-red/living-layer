import { useState } from 'react';
import {
  MAX_OTHER_OBJECTS,
  OBSERVATION_MAX_AGE_MS,
  isMugConcept,
  objectById,
  type DeskMemory,
  type EvidenceRun,
  type PlacementDecision,
} from '@livinglayer/domain';
import { estimateLabel } from '../cost';
import { Glyph } from '../Glyph';
import { useLab } from './LabContext';
import { Cost, Details, Panel, useCall } from './panel';
import { FixturePanel, LampPanel, NewFixturePanel, ScanFixtures } from './FixturePanel';
import { ago, mainSurface, roomLabel, surfaceRows } from './labels';
import { pinScene, viewLabel, type Selection } from './progress';
import { TRANSITION, centre } from './useLabState';

type Events = { memory: DeskMemory; events: EvidenceRun<PlacementDecision>[] };

/** A ring that empties as a sighting ages towards the 5-minute expiry. */
function Freshness({ observedAt }: { observedAt: string }) {
  const { now } = useLab();
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
const verdictSummary = (
  memory: DeskMemory | undefined,
  events: EvidenceRun<PlacementDecision>[],
) =>
  events.length
    ? events
        .map((e) => {
          const r = memory?.rules?.find((x) => x.id === e.output.ruleId);
          return `${r?.label ?? 'Zone'}: ${e.output.decision}${e.output.action !== 'none' ? `, light ${e.output.action}` : ''}`;
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
            <button
              key={d.objectId}
              className="secondary"
              disabled={Boolean(busy) || !segmentRunId || d.objectId === confirmedId}
              onClick={async () => {
                await lab.deskAction('select', { segmentRunId, detectionId: d.objectId });
                lab.select({ kind: 'object', id: 'main' });
              }}
            >
              Confirm mug mask #{d.objectId}
            </button>
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
                <button
                  className="secondary"
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
                </button>
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
            <button
              className={s.state === 'current' ? 'primary' : 'text-button'}
              disabled={s.state === 'locked'}
              onClick={() => lab.goToStep(s.id)}
            >
              {s.state === 'done' ? 'Open' : 'Go'}
            </button>
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
  const picture = view === 'desk' ? memory?.deskIllustration : memory?.illustration;
  // The room is drawn from its own photo once it has one; the desk always from this frame.
  const needPhoto =
    mode === 'live' && !image && (view === 'desk' || !(memory?.scenePhoto || memory?.illustration));
  const what = view === 'desk' ? 'desk' : 'room';
  const drawnFrom = picture?.drawnFrom;
  const otherSize =
    drawnFrom && (drawnFrom.width !== dimensions.width || drawnFrom.height !== dimensions.height);
  return (
    <div className="picture-controls">
      <button
        className="secondary"
        disabled={Boolean(busy) || !pinned || needPhoto || (mode === 'live' && !lab.metaReady)}
        onClick={() => void lab.illustrate(view)}
      >
        {busy === 'illustrate'
          ? 'Drawing…'
          : picture
            ? `Redraw the ${what} picture`
            : view === 'desk'
              ? 'Draw the desk as a picture'
              : 'Draw it as a picture'}
      </button>
      <p className="micro">
        {!pinned
          ? 'Pin the desk first: the picture is tied to it.'
          : needPhoto
            ? view === 'desk'
              ? 'Capture a close frame of the desk first; the picture is drawn from it.'
              : 'Add the room’s photo first; the picture is drawn from it.'
            : mode === 'demo'
              ? `Demo: shows a ready-made picture of the illustrated desk, with no model calls.`
              : view === 'desk'
                ? otherSize
                  ? `The desk picture was drawn from a ${drawnFrom!.width}×${drawnFrom!.height} frame, so only sightings in frames that size show on it. Redraw from this frame to match.`
                  : `Muse Image redraws this close frame of the desk${memory?.illustration ? ' in the room picture’s style' : ''}, keeping its framing, so what the camera tracks lands on it: one image call, about $0.01.`
                : picture && !picture.desk
                  ? 'SAM found no desk in the last picture, so the mug and zones can’t be placed on it. Redraw to try again.'
                  : `Muse Image redraws ${memory?.scenePhoto || memory?.illustration ? 'the room’s photo' : 'the current photo'} as isometric line art on a transparent background, and SAM finds its desk: one image and one SAM call, about $0.0125.`}
      </p>
      {view === 'room' && picture?.desk && <LiftFixtures />}
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
        <button className="secondary" disabled={blocked} onClick={() => void lab.separate()}>
          {busy === 'separate'
            ? 'Lifting…'
            : layers
              ? 'Lift them again'
              : 'Lift the fixtures off the picture'}
        </button>
        {layers && (
          <button
            className="text-button"
            disabled={Boolean(busy)}
            onClick={() => void lab.separate(true)}
          >
            Put them back
          </button>
        )}
      </div>
      <p className="micro">
        {!count
          ? 'Scan or add this room’s fixtures first.'
          : layers
            ? `${layers.sprites.length} of ${count} fixtures are lifted: dragging one moves the thing itself. Lift again after adding fixtures.`
            : mode === 'demo'
              ? 'Cuts each fixture out of the picture and fills the gap it leaves, with no model calls.'
              : 'Spark finds each fixture on the picture by name and SAM cuts it out, and Muse Image redraws the room with only its furniture as the base they stand on, so you can drag the things themselves. A fixture that can’t be outlined cleanly isn’t lifted. One Spark, one SAM and one image call, about $0.02.'}
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
            ? 'Draft your office from a photo in the canvas: upload one, or capture a camera frame and use it. Review the draft, then save.'
            : room === 'office'
              ? 'The demo office: an illustrated preset you can edit.'
              : 'A preset scene. Pin one of its surfaces to place objects.'
      }
      tone="ok"
    >
      {lab.isoPanel === 'scene' && lab.stageView !== 'photo' ? (
        <button className="secondary" onClick={() => lab.setIsoPanel('room')}>
          Done editing
        </button>
      ) : (
        <button className="primary" disabled={!workScene} onClick={lab.editLayout}>
          Edit layout
        </button>
      )}
      <p className="micro">
        Draft the room from a photo, start from a preset, or move, turn and add furniture. The
        layout opens in the canvas.
      </p>
      {room === 'custom' && <PictureControls />}
      {memory?.surface && pinScene(room) === memory.surface.scene && (
        <button
          className="text-button"
          disabled={Boolean(lab.busy) || Boolean(lab.pinning)}
          onClick={() => void lab.adjustPin()}
        >
          Adjust the pin’s corners on the photo →
        </button>
      )}
      <ScanFixtures initial={pinScene(room)} open />
      {progress.view && (
        <button className="text-button" onClick={() => lab.select({ kind: 'view' })}>
          {progress.pinned ? 'Open the' : 'Next: set up the'}{' '}
          {viewLabel(progress.view).toLowerCase()} →
        </button>
      )}
      <label className="field">
        <span className="tiny">ROOM</span>
        <select
          aria-label="Room"
          value={room}
          disabled={Boolean(busy)}
          onChange={(e) => lab.pickScene(e.target.value as typeof room)}
        >
          <option value="office">Office</option>
          <option value="fridge">Fridge</option>
          {memory?.scene && <option value="custom">{memory.scene.label}</option>}
        </select>
      </label>
      {rows.room.length > 0 && (
        <Details summary={`Surfaces · ${rows.room.length + rows.view.length}`} open>
          <ul className="insp-list">
            {[...rows.view, ...rows.room].map((r) => (
              <li key={r.surface.id}>
                <button
                  className="text-button"
                  onClick={() => lab.select({ kind: 'surface', id: r.surface.id })}
                >
                  {r.surface.label}
                </button>
                <small>{r.pinned ? '✓ pinned' : '◌ not pinned'}</small>
              </li>
            ))}
          </ul>
        </Details>
      )}
      <Details summary="Ask Spark">
        <p className="micro">
          Spark looks at the current photo and says which preset it shows and which props it can
          see. It never invents positions.
        </p>
        <button
          className="secondary"
          disabled={Boolean(busy) || lab.asking || room === 'custom' || (mode === 'live' && !image)}
          onClick={() => void lab.askGuess()}
        >
          {lab.asking ? 'Asking Spark…' : 'Guess scene'}
        </button>
        {guess && <p className="micro">Spark: {guess.summary}</p>}
      </Details>
    </Panel>
  );
}

/** Pin a surface to the camera frame: the bridge between the photo and the iso room. */
function SurfacePanel({ id, closeView }: { id: string; closeView?: boolean }) {
  const lab = useLab();
  const { memory, mode, image, busy, progress, pinning, status } = lab;
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
        <button className="secondary" onClick={lab.editLayout}>
          Edit layout
        </button>
      </Panel>
    );
  const label = row.surface.label.toLowerCase();
  const demoPin = mode === 'demo' && !memory?.surface && row.pinned;
  const needPhoto = mode === 'live' && !image;
  const title = closeView && progress.view ? viewLabel(progress.view) : row.surface.label;
  // The fitter measures desk-shaped tops: a desk or a table, seen from above its front edge.
  const findable = /^(desk|table)/.test(row.surface.id) || row.surface.id === progress.deskId;
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
            ? `The ${label} is pinned on a ${memory!.surface!.frame.width}×${memory!.surface!.frame.height} frame. Objects on it show in the iso room.`
            : needPhoto
              ? `Add a close photo of the ${label}, then pin its four corners.`
              : `Pin the ${label} to the photo, so objects on it show in the iso room.`
      }
      tone={row.pinned ? 'ok' : 'seen'}
    >
      {row.pinned ? (
        <button
          className="primary"
          onClick={() =>
            lab.select(memory?.object ? { kind: 'object', id: 'main' } : { kind: 'add' })
          }
        >
          {memory?.object ? `Open ${memory.object.label}` : 'Find objects'} <Glyph type="arrow" />
        </button>
      ) : needPhoto ? (
        <div className="save-actions">
          <button
            className="primary"
            disabled={Boolean(busy)}
            onClick={() => lab.file.current?.click()}
          >
            Upload a close photo
          </button>
          <button
            className="secondary"
            disabled={Boolean(busy) || lab.cameraPending || lab.camera}
            onClick={() => void lab.startCamera()}
          >
            Use the camera
          </button>
        </div>
      ) : null}
      {findable && !row.pinned && status && (
        <Cost>{estimateLabel(status.meta.estimates.segment, 'image')}</Cost>
      )}
      {closeView && row.pinned && progress.view && (
        <p className="micro">
          The {label} is shared with the {roomLabel(progress.room, memory).toLowerCase()}, so what
          you place here shows there too.
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
          <button
            className={row.pinned || needPhoto ? 'secondary' : 'primary'}
            disabled={Boolean(busy) || Boolean(pinning) || lab.camera || needPhoto}
            onClick={() =>
              void lab.autoPin({ scene: pinScene(row.scene), surfaceId: row.surface.id, label })
            }
          >
            {busy === 'autopin' ? 'Finding…' : row.pinned ? 'Find it again' : `Find the ${label}`}
          </button>
        )}
        <button
          className={row.pinned || needPhoto || findable ? 'secondary' : 'primary'}
          disabled={Boolean(busy) || Boolean(pinning) || lab.camera || needPhoto}
          onClick={() => {
            lab.setDrawing(false);
            lab.setPinning({ scene: pinScene(row.scene), surfaceId: row.surface.id, label });
          }}
        >
          {row.pinned && memory?.surface ? 'Re-pin surface' : 'Pin surface'}
        </button>
        {memory?.surface && row.pinned && (
          <button
            className="text-button"
            disabled={Boolean(busy)}
            onClick={() => void lab.deskAction('surface', { pin: null })}
          >
            Clear pin
          </button>
        )}
      </div>
      {closeView && (
        <Details summary="Start over">
          <p className="micro">
            Forget the mug, its zone and its sightings. The evidence log stays.
          </p>
          <button
            className="text-button destructive"
            disabled={Boolean(busy) || !memory?.object}
            onClick={() => void lab.deskAction('reset')}
          >
            Reset desk memory
          </button>
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
  const needPhoto = mode === 'live' && !image;
  return (
    <Panel
      tiny={preset ? 'SUGGESTED BY SPARK' : 'ADD AN OBJECT'}
      title={preset ? preset.label : 'Find an object'}
      status={
        preset
          ? `${preset.appearance}. Find its outline, then confirm it.`
          : needPhoto
            ? 'Add a photo of the desk first: upload one or capture a camera frame.'
            : 'Name what to look for. SAM outlines every match in this frame.'
      }
      tone={needPhoto ? 'unsure' : 'seen'}
    >
      {preset ? (
        <button
          className="primary"
          disabled={!canVision || camera}
          onClick={() => {
            lab.setConcept(preset.category);
            void lab.execute('segment', preset.category);
          }}
        >
          {busy === 'segment' ? 'Decoding…' : 'Find its outline'}
          <Glyph type="arrow" />
        </button>
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
                if (e.key === 'Enter' && canVision && concept.trim() && !camera)
                  void lab.execute('segment');
              }}
            />
            <span>↵ TO RUN</span>
          </div>
          <button
            className="primary"
            disabled={!canVision || !concept.trim() || camera}
            onClick={() => void lab.execute('segment')}
          >
            {busy === 'segment' ? 'Decoding…' : 'Segment object'}
            <Glyph type="arrow" />
          </button>
        </>
      )}
      {status && <Cost>{estimateLabel(status.meta.estimates.segment, 'image')}</Cost>}
      <MaskResults />
      {!preset && (
        <Details summary="Not sure what’s there?" open={!scene}>
          <p className="micro">
            Spark names up to three objects on the desk. They show in the outline as suggestions.
          </p>
          <button
            className="secondary"
            disabled={!canVision || camera}
            onClick={() => void lab.execute('discover')}
          >
            {busy === 'discover' ? 'Discovering…' : 'Discover objects'}
          </button>
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
        <p className="micro">
          Ask for something that isn’t there. A good result is no outline at all.
        </p>
        <button
          className="text-button"
          disabled={!canVision || camera}
          onClick={() => void lab.execute('segment', 'unicorn')}
        >
          Test absent target <span>↗</span>
        </button>
      </Details>
    </Panel>
  );
}

function MugPanel() {
  const lab = useLab();
  const { memory, mode, camera, busy, status, follow, followView, followStats, localZone, now } =
    lab;
  const { currentObservation, observationStale, sightings } = lab;
  if (!memory?.object)
    return (
      <Panel
        tiny="OBJECT · MAIN"
        title="No mug yet"
        status="Find the mug and confirm its outline first."
        tone="unsure"
      >
        <button className="primary" onClick={() => lab.select({ kind: 'add' })}>
          Find the mug
        </button>
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
      <button
        className="primary"
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
      </button>
      <p className="micro">
        {mode === 'demo'
          ? 'Move the mug with the buttons under the canvas, then track it.'
          : 'Move the mug, start the camera, then capture & track.'}
      </p>
      {status && <Cost>{estimateLabel(status.meta.estimates.segment, 'track')}</Cost>}
      <button
        className="secondary"
        disabled={follow ? false : Boolean(busy) || !currentObservation}
        onClick={() => (follow ? lab.stopFollow() : void lab.startFollow())}
        title="Follow the mug frame to frame in the browser, calling SAM only at the zone edge or when the match gets weak"
      >
        {follow ? 'Stop following' : 'Follow locally'}
      </button>
      <p className="micro">
        {follow
          ? `${followStats.frames} local step${followStats.frames === 1 ? '' : 's'} · ${followStats.checks} SAM check${followStats.checks === 1 ? '' : 's'}${followView ? ` · match ${followView.track.score.toFixed(2)}` : ''}${localZone ? '' : ' · no zone to watch: save one and mark the camera fixed'}`
          : currentObservation
            ? 'Follows the mug in the browser between SAM calls. SAM confirms each zone crossing before the lamp can fire.'
            : 'Track the mug in this frame first.'}
      </p>
      <div className="insp-links">
        <button className="text-button" onClick={() => lab.select({ kind: 'rule', id: 'main' })}>
          {memory.zone ? 'Zone and light' : 'Draw its zone'} →
        </button>
        <button
          className="text-button"
          disabled={Boolean(busy)}
          onClick={() => lab.openModel(undefined)}
        >
          Edit model {memory.item ? '· fitted' : ''} →
        </button>
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
        <button
          className="text-button destructive"
          disabled={Boolean(busy)}
          onClick={() => void lab.deskAction('reset')}
        >
          Reset desk memory
        </button>
      </Details>
    </Panel>
  );
}

function OtherPanel({ id }: { id: string }) {
  const lab = useLab();
  const { memory, segmentation, segmentRunId, canVision, camera, now } = lab;
  const { call, off } = useCall();
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
          ? `Seen ${ago(o.observation.observedAt, now)}. It is followed in outlines of “${o.concept}”.`
          : `Remembered. It is followed in outlines of “${o.concept}”.`
      }
      tone="chosen"
      aside={o.observation && <Freshness observedAt={o.observation.observedAt} />}
    >
      {canTrack ? (
        <button
          className="primary"
          disabled={off}
          onClick={() =>
            void call<Events>('desk/objects/track', { objectId: o.id, segmentRunId }, (r) => {
              lab.setMemory(r.memory, false);
              lab.setMessage(`Tracked the ${o.label}. ${verdictSummary(r.memory, r.events)}`);
            })
          }
        >
          Track
        </button>
      ) : (
        <button
          className="primary"
          disabled={!canVision || camera}
          onClick={() => void lab.execute('segment', o.concept)}
        >
          Find it in this frame
        </button>
      )}
      <p className="micro">
        {canTrack
          ? `The newest outlines are of “${o.concept}”. Match one to the ${o.label}.`
          : 'Outline it in this frame, then track it.'}
      </p>
      <div className="insp-links">
        {lab.entities.length > 0 && o.observation && (
          <button className="text-button" onClick={() => lab.startRule(o.id)}>
            Add a rule for it →
          </button>
        )}
        <button className="text-button" disabled={off} onClick={() => lab.openModel(o.id)}>
          Edit model →
        </button>
      </div>
      <Details summary="Forget">
        <button
          className="text-button destructive"
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
        </button>
      </Details>
    </Panel>
  );
}

/** The mug's own zone and the main lamp. */
function ZonePanel() {
  const lab = useLab();
  const { memory, mode, busy, drawing, draftZone, currentObservation, lampReady, camera } = lab;
  if (!memory?.object)
    return (
      <Panel
        tiny="RULE · MAIN"
        title="Main zone"
        status="Remember the mug first; its zone is drawn on a frame it was seen in."
        tone="unsure"
      >
        <button className="primary" onClick={() => lab.select({ kind: 'add' })}>
          Find the mug
        </button>
      </Panel>
    );
  const d = memory.lastDecision?.output;
  const lampName = mode === 'demo' ? 'virtual lamp' : 'lamp';
  const status = !memory.zone
    ? currentObservation
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
      <button
        className="secondary"
        disabled={Boolean(busy) || !currentObservation || camera}
        onClick={() => {
          lab.setDraftZone(memory.zone?.rect ?? { x: 0.3, y: 0.2, width: 0.4, height: 0.6 });
          lab.setDrawing(true);
        }}
      >
        Draw / edit zone
      </button>
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
                    lab.setDraftZone((z) => ({ ...z, [key]: Number(e.target.value) / 100 }))
                  }
                />
              </label>
            ))}
          </div>
          <button
            className="primary"
            disabled={Boolean(busy) || !currentObservation}
            onClick={() =>
              void lab.deskAction('zone', {
                observationId: currentObservation?.id,
                rect: draftZone,
              })
            }
          >
            Save zone
          </button>
        </div>
      )}
      <button
        className="physical"
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
      </button>
      {mode === 'live' && !lampReady && (
        <p className="micro">
          The lamp isn’t set up, so placement can’t be verified live. Set the HA_ variables and
          HA_LIVE_ENABLED, or try the rule in Demo.
        </p>
      )}
      {!currentObservation && memory.zone && (
        <p className="micro">
          Track the mug in this frame first. A still photo doesn’t prove where it is now.
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
        <label className="overlay-toggle">
          <input
            type="checkbox"
            checked={Boolean(memory.fixedCamera)}
            disabled={Boolean(busy)}
            onChange={(e) => void lab.deskAction('camera', { fixed: e.target.checked })}
          />
          The camera is fixed: keep the zone for new frames of the same size
        </label>
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
  const object = memory && objectById(memory, r.objectId)?.label;
  return (
    <Panel
      tiny="RULE"
      title={r.label}
      status={
        !d
          ? 'Not checked yet. Track the object or check the rules.'
          : d.decision === 'inside'
            ? d.action === 'confirmed'
              ? `The ${object ?? 'object'} is in the zone. ${r.entityId} turned on.`
              : `The ${object ?? 'object'} is in the zone.`
            : d.decision === 'outside'
              ? `The ${object ?? 'object'} is outside the zone.`
              : `Blocked: ${d.reason}`
      }
      tone={
        !d ? 'seen' : d.decision === 'blocked' ? 'unsure' : d.action === 'confirmed' ? 'warm' : 'ok'
      }
    >
      <p className="rule-sentence">
        When <strong>{object ?? 'a forgotten object'}</strong> is {r.placement}{' '}
        <strong>{r.label}</strong>, turn on <strong>{r.entityId}</strong>.
      </p>
      <button
        className="primary"
        disabled={off}
        onClick={() =>
          void call<Events>('desk/rules/verify', {}, (res) => {
            lab.setMemory(res.memory, false);
            lab.setMessage(verdictSummary(res.memory, res.events));
          })
        }
      >
        Check rules
      </button>
      <Details summary="Delete">
        <button
          className="text-button destructive"
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
        </button>
      </Details>
    </Panel>
  );
}

/** A rule as a sentence: when [object] is inside [a zone you drag] turn on [light]. */
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
  ];
  const set = (patch: Partial<typeof draft>) => lab.setRuleDraft({ ...draft, ...patch });
  return (
    <Panel
      tiny="NEW RULE"
      title="When something is in a zone…"
      status={
        draft.rect
          ? `Zone drawn: ${Math.round(draft.rect.width * 100)}×${Math.round(draft.rect.height * 100)}% of the frame.`
          : mainSurface(lab) || lab.progress.pinned
            ? 'Drag on the iso surface to draw the zone.'
            : 'Pin a surface first, so the zone can be drawn on it.'
      }
      tone={draft.rect ? 'chosen' : 'seen'}
    >
      <div className="rule-builder">
        <span>When</span>
        <select
          aria-label="Rule object"
          value={draft.objectId}
          onChange={(e) => set({ objectId: e.target.value, rect: null })}
        >
          {objects.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <span>is inside</span>
        <input
          aria-label="Rule name"
          placeholder="Zone name"
          maxLength={40}
          value={draft.label}
          onChange={(e) => set({ label: e.target.value })}
        />
        <span>turn on</span>
        <select
          aria-label="Rule light"
          value={draft.entityId}
          onChange={(e) => set({ entityId: e.target.value })}
        >
          {entities.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="save-actions">
        <button
          className="primary"
          disabled={off || !draft.rect || !draft.label.trim() || !draft.entityId}
          onClick={() =>
            void call<DeskMemory>(
              'desk/rules/save',
              {
                rule: {
                  label: draft.label.trim(),
                  objectId: draft.objectId,
                  entityId: draft.entityId,
                  rect: draft.rect,
                },
              },
              (m) => {
                lab.setMemory(m);
                lab.setMessage(
                  `Saved "${draft.label.trim()}". Check rules or track the object to try it.`,
                );
                const saved = m.rules?.at(-1);
                lab.select(saved ? { kind: 'rule', id: saved.id } : null);
              },
            )
          }
        >
          Save rule
        </button>
        <button className="secondary" onClick={() => lab.select(null)}>
          Cancel
        </button>
      </div>
      {!entities.length && (
        <p className="micro">
          Set HA_ENTITY_ID (and HA_EXTRA_ENTITY_IDS for more lights, HA_SWITCH_ENTITY_IDS for
          switches) to choose what a rule turns on.
        </p>
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
  }
}

/** Properties and actions for whatever the outline has selected. */
export function Inspector() {
  const lab = useLab();
  return (
    <aside className="ws-inspector" aria-label="Inspector">
      {lab.selection && lab.progress.room && (
        <div className="pane-head">
          <button className="text-button" onClick={() => lab.select(null)}>
            ← Setup
          </button>
        </div>
      )}
      {body(lab, lab.selection)}
    </aside>
  );
}
