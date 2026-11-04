import { useRef, useCallback } from 'react';
import type {
  DeskMemory,
  Fixture,
  MappedThing,
  IsoSceneKind,
  FixtureInput,
  SelectionShape,
} from '@livinglayer/domain';
import { closeViewOf, fixtureAt, fixtureBox, inRoomView, fixtureInput } from '@livinglayer/domain';
import { api } from '../../api';
import type { FixturePlacing } from '../../iso/IsoView';
import { SHORTCUTS } from '../../shortcuts';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import type { DeskSlice } from './desk';
import type { FollowStateSlice } from './follow-state';
import type { CameraSlice } from './camera';
import type { ObservationSlice } from './observation';
import type { TrackingSlice } from './tracking';
import type { NavigationSlice } from './navigation';
import type { AiSlice } from './ai';
import { jobDone } from './follow-job';
import { useStableSlice } from './stable';

/** The Fixtures slice of the lab's state. */
export function useFixturesSlice(
  deps: ViewSlice &
    FeedbackSlice &
    RunLogSlice &
    DeskSlice &
    FollowStateSlice &
    CameraSlice &
    ObservationSlice &
    TrackingSlice &
    NavigationSlice &
    AiSlice,
): FixturesSlice {
  const {
    aiRun,
    busy,
    closeAiTaskSoon,
    costNote,
    demoPosition,
    followAi,
    frameNow,
    image,
    memory,
    mode,
    openModel,
    placing,
    refresh,
    segmentRunId,
    selection,
    setBusy,
    setError,
    setIsoPanel,
    setMemory,
    setMessage,
    setOutlining,
    setPlacing,
    setSegmentRunId,
    setSegmentation,
    setSelected,
    setSelection,
    setShowPicture,
    setStageView,
    setWorkScene,
    stageView,
    watching,
    workScene,
  } = deps;
  /** Look for a fixture where it should stand in the camera's view; its outlines show for confirming. */
  async function findFixture(id: string) {
    setBusy('find-fixture');
    setError('');
    try {
      const imageDataUrl = frameNow();
      if (mode === 'live' && !imageDataUrl)
        throw new Error('Start the camera or add a photo of the desk to look in.');
      const run = await api('fixtures/find', {
        mode,
        id,
        ...(imageDataUrl ? { imageDataUrl } : {}),
      });
      setSegmentation(run.output);
      setSegmentRunId(run.id);
      setMessage(
        run.output.detections.length
          ? `Found ${run.output.detections.length} outline${run.output.detections.length === 1 ? '' : 's'}${costNote(run)}. Confirm which one it is.`
          : `SAM found nothing where it should stand${costNote(run)}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not look for it.');
    } finally {
      setBusy('');
      void refresh().catch(() => {});
    }
  }
  /**
   * Outline a fixture from what a person drew round it on the picture, on this
   * machine with no model call, or by SAM with `sam` (one billed call): a
   * segmentation of its name with one outline, confirmed with `anchorFixture`
   * like SAM's search by name.
   */
  async function outlineFixture(
    id: string,
    drawn: { shape: SelectionShape; held: string | null },
    sam = false,
  ) {
    const fixture = memory?.fixtures?.find((f) => f.id === id);
    if (!fixture) return;
    setBusy('outline-fixture');
    setError('');
    try {
      const imageDataUrl = drawn.held ?? frameNow();
      if (mode === 'live' && !imageDataUrl)
        throw new Error('Start the camera or add a photo of the desk to outline it on.');
      const run = await api('segment', {
        mode,
        concept: fixture.label.trim().toLowerCase(),
        shape: drawn.shape,
        ...(sam ? { sam } : {}),
        ...(mode === 'demo' ? { demoPosition } : { imageDataUrl }),
      });
      setSegmentation(run.output);
      setSegmentRunId(run.id);
      setOutlining(null);
      setMessage(
        run.output.detections.length
          ? sam
            ? `SAM outlined it${costNote(run)}. Confirm it’s the outline.`
            : 'Outlined it on this machine, no model call. Confirm it’s the outline.'
          : sam
            ? `SAM found nothing inside what you drew${costNote(run)}. Draw it closer round the thing.`
            : 'Nothing stood out inside what you drew. Draw it closer round the thing.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not outline it.');
    } finally {
      setBusy('');
      void refresh().catch(() => {});
    }
  }
  /** Put one of a fixture's earlier drafts back as its model; the current one is kept. */
  async function chooseFixtureDraft(id: string, draft: number) {
    setBusy('fixture-draft');
    setError('');
    try {
      setMemory(await api('fixtures/choose', { mode, fixtureId: id, draft }));
      setMessage('Put that draft back. The one it replaced is kept among the earlier drafts.');
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not use that draft.');
    } finally {
      setBusy('');
    }
  }
  /**
   * Another photo of a fixture, fitted and fused with its model: a close one
   * of a thing the room's camera sees too small. The demo uses its own.
   */
  async function addFixturePhoto(id: string, imageDataUrl?: string) {
    setBusy('fixture-photo');
    setError('');
    try {
      const { run, memory: next } = await api('fixtures/photo', {
        mode,
        fixtureId: id,
        ...(imageDataUrl ? { imageDataUrl } : {}),
      });
      setMemory(next);
      setMessage(
        `Fitted the photo and fused it with ${run.output.views - 1} earlier view${run.output.views === 2 ? '' : 's'}: ${Math.round(run.output.iou * 100)}% outline match${costNote(run)}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not fit the photo.');
    } finally {
      setBusy('');
      void refresh().catch(() => {});
    }
  }
  async function anchorFixture(id: string, detectionId: string) {
    if (!segmentRunId) return;
    setBusy('anchor-fixture');
    setError('');
    try {
      const next = await api('fixtures/anchor', {
        mode,
        id,
        segmentRunId,
        detectionId,
      });
      setMemory(next);
      setMessage(
        watching
          ? 'Confirmed. The server follows it from now on.'
          : 'Confirmed. Watch on the server to follow it from now on.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not confirm it.');
    } finally {
      setBusy('');
    }
  }
  async function untrackFixture(id: string) {
    setError('');
    try {
      setMemory(await api('fixtures/untrack', { mode, id }));
      setMessage('No longer followed. It stays where it was last seen.');
    } catch (e) {
      setError(e instanceof Error ? e : 'Could not stop following it.');
    }
  }
  /**
   * Draw the photographed room as a picture from the current photo (one
   * image call and one SAM call, live), and show it, step by step in the
   * AI dialog, where it can be stopped.
   */
  async function illustrate(view: 'room' | 'desk' = 'room', note?: string) {
    if (busy) return;
    // The desk is drawn from what the camera shows now, not the last frame captured.
    const photo = view === 'desk' ? frameNow() : image;
    setBusy('illustrate');
    setError('');
    let ok = false;
    try {
      const result = await followAi(
        {
          title: view === 'desk' ? 'Drawing the desk' : 'Drawing the room',
          description:
            mode === 'live'
              ? view === 'desk'
                ? 'Muse Image redraws this frame in the room’s style. One image call, about $0.01.'
                : 'Muse Image redraws the corner camera’s frame, keeping its framing. One image call, about $0.01.'
              : 'Demo: the saved room through the demo camera, no model calls.',
        },
        (jobId, signal) =>
          api(
            'scene/illustrate',
            {
              mode,
              view,
              jobId,
              // The room is redrawn from its own photo (the last picture's, else this one); the desk from this frame.
              ...(mode === 'live' &&
              (view === 'desk' || !(memory?.scenePhoto || memory?.illustration))
                ? { imageDataUrl: photo }
                : {}),
              ...(note?.trim() ? { note: note.trim() } : {}),
            },
            { signal },
          ),
      );
      if (!result) return;
      ok = true;
      setMemory(result.memory);
      setSelected(result.run);
      setShowPicture(true);
      if (stageView === 'photo') setStageView('iso');
      setMessage(
        view === 'desk'
          ? `Drew the desk from this frame${costNote(result.run)}. Sightings in frames this size show on it.`
          : `Drew the room as a picture${costNote(result.run)}. The room’s camera places the mug and zones on it.`,
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The room could not be drawn.');
    } finally {
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'illustrate' ? '' : b));
      // A clean finish closes itself after a moment to look at it.
      if (ok) closeAiTaskSoon(2200);
    }
  }
  /**
   * Scan a view's photo and map what stays put into a scene (one Spark and one
   * SAM call, live), step by step in the AI dialog, where it can be stopped.
   * Resolves to what each thing became, or null when it failed or was stopped.
   */
  async function scanFixtures(
    scene: IsoSceneKind | 'custom',
    replace: boolean,
    addNew: boolean,
  ): Promise<MappedThing[] | null> {
    return (await scan(scene, replace, addNew))?.mapped ?? null;
  }
  async function scan(
    scene: IsoSceneKind | 'custom',
    replace: boolean,
    addNew: boolean,
    follow = false,
  ) {
    if (busy) return null;
    // What the camera shows now, which is the frame the pin was set on, not the last one captured.
    const photo = frameNow();
    setBusy('scan');
    setError('');
    try {
      const result = await followAi(
        {
          title: 'Scanning and mapping',
          description:
            mode === 'live'
              ? 'Spark lists what stays put, SAM outlines each one, and each is placed through the pin. One Spark and one SAM call.'
              : 'Demo: the office from its corner camera, no model calls.',
        },
        (jobId, signal) =>
          api(
            'fixtures/scan',
            {
              mode,
              scene,
              replace,
              addNew,
              ...(follow ? { follow } : {}),
              jobId,
              ...(mode === 'live' ? { imageDataUrl: photo } : {}),
            },
            { signal },
          ),
      );
      if (!result) return null;
      setMemory(result.memory);
      setSelected(result.run);
      const added = result.mapped.filter((m) => m.fixture).length;
      const moved = result.mapped.filter((m) => m.moveTo || m.moveBy).length;
      setMessage(
        result.mapped.length
          ? `Scanned ${result.mapped.length} thing${result.mapped.length === 1 ? '' : 's'}; moved ${moved}${addNew ? `, added ${added}` : ''}${costNote(result.run)}.`
          : 'The scan found nothing that stays put.',
      );
      void refresh().catch(() => {});
      return { ...result, photo };
    } catch (e) {
      setError(e instanceof Error ? e : 'The scan failed.');
      return null;
    } finally {
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'scan' ? '' : b));
    }
  }
  /**
   * Everything on the desk from one look: a scan that adds what the room
   * hasn't got and follows each thing from SAM's outline in it (no call past
   * the scan's own): what stays put as a fixture, a mug as the desk's mug,
   * anything else that moves as an object.
   */
  async function findOnDesk(scene: IsoSceneKind | 'custom') {
    const scanned = await scan(scene, true, true, true);
    if (!scanned) return;
    const { followed, missed } = scanned;
    const list = (labels: string[]) => labels.join(', ').toLowerCase();
    setMessage(
      `${followed.length ? `Following ${list(followed)} from the scan’s outlines` : 'The scan outlined nothing to follow'}${missed.length ? `; SAM didn’t outline ${list(missed)}: draw round ${missed.length === 1 ? 'it' : 'them'} in ${missed.length === 1 ? 'its' : 'their'} panel` : ''}${costNote(scanned.run)}.${watching || !followed.length ? '' : ' Watch on the server to keep following them.'}`,
    );
  }
  /**
   * Lift the room's fixtures off its picture, so dragging one moves the thing
   * itself (one SAM call and one image call, live), or put them back.
   */
  async function separate(back = false) {
    if (busy) return;
    setBusy('separate');
    setError('');
    try {
      if (back) {
        const result = await api('scene/separate/undo', { mode });
        setMemory(result.memory);
        setMessage('The fixtures are back in the picture.');
        return;
      }
      const result = await followAi(
        {
          title: 'Lifting the fixtures',
          description:
            mode === 'live'
              ? 'Spark finds each fixture on the picture, SAM outlines it, and Muse Image redraws the room without them. About $0.02.'
              : 'Demo: cut out where the layout puts them, no model calls.',
        },
        (jobId, signal) => api('scene/separate', { mode, jobId }, { signal }),
      );
      if (!result) return;
      setMemory(result.memory);
      setSelected(result.run);
      setShowPicture(true);
      if (stageView === 'photo') setStageView('iso');
      setMessage(
        `Lifted ${result.lifted} fixture${result.lifted === 1 ? '' : 's'} off the picture${costNote(result.run)}. Drag one to move it.` +
          (result.skipped.length
            ? ` Not lifted, as they couldn’t be outlined cleanly: ${result.skipped.join(', ').toLowerCase()}.`
            : ''),
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixtures could not be lifted off the picture.');
    } finally {
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'separate' ? '' : b));
    }
  }
  /**
   * Rebuild a fixture's model with Spark from the picture of it (two Spark
   * calls, live; a third looks up what the person says of it, `note`, first),
   * step by step in the AI dialog where it can be stopped, then open it to edit.
   */
  /**
   * Refine a fixture's shape with SAM 3D (experimental). It takes minutes,
   * so the server answers at once and this follows its job to the end; the
   * lab stays usable meanwhile, and the server saves the result either way.
   */
  async function refineFixture3d(id: string) {
    // It leaves the lab usable while it runs, but doesn't start over another action.
    if (busy || aiRun.current) return;
    const f = memory?.fixtures?.find((x) => x.id === id);
    if (!f) return;
    setError('');
    try {
      const job = await followAi(
        {
          title: `Refining the ${f.label.toLowerCase()} with SAM 3D`,
          description:
            'SAM 3D reconstructs it whole from its photo crop, and its profile, height and handle replace the fit’s. About 10 minutes on this machine. Experimental.',
        },
        async (jobId, signal) => {
          await api('fixtures/refine3d', { mode, fixtureId: id, jobId }, { signal });
          // Its end, heard over the job's event stream (the dialog follows the steps on its own).
          const job = await jobDone(jobId, signal);
          if (job.outcome === 'failed') throw new Error(job.error ?? 'SAM 3D failed.');
          return job;
        },
      );
      if (!job) return;
      await refresh();
      setMessage(
        `SAM 3D: ${job.steps.find((s) => s.id === 'check')?.detail ?? 'done'}. The old shape is under Earlier drafts.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'SAM 3D could not refine it.');
    }
  }
  /** `saved` is the memory a save just returned, when it is called before the lab has it. */
  async function sculptFixture(id: string, note?: string, saved?: DeskMemory) {
    if (busy) return;
    const f = (saved ?? memory)?.fixtures?.find((x) => x.id === id);
    if (!f) return;
    setBusy('sculpt');
    setError('');
    try {
      const result = await followAi(
        {
          title: `Modelling the ${f.label.toLowerCase()}`,
          description: note
            ? `Spark drafts its model in parts from its picture three ways at once and the best is kept, while “${note}” is looked up. Four Spark calls, about $0.05 to $0.15.`
            : 'Spark drafts its model in parts from its picture three ways at once, and the best is kept. Three Spark calls, about $0.05 to $0.10.',
        },
        (jobId, signal) =>
          api(
            'fixtures/sculpt',
            { mode, fixtureId: id, jobId, ...(note ? { note } : {}) },
            { signal },
          ),
      );
      if (!result) return;
      setMemory(result.memory);
      setSelected(result.run);
      const out = result.run.output;
      if (!('sculpted' in out)) return;
      setMessage(
        `Modelled the ${f.label.toLowerCase()}${out.product ? ` as the ${out.product}` : ''} in ${out.parts} parts${costNote(result.run)}. ${out.note} Edit it here; undo puts the old model back.`,
      );
      openModel(id);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be modelled.');
    } finally {
      // A stop has already freed the lab for the next call.
      if (!aiRun.current) setBusy((b) => (b === 'sculpt' ? '' : b));
    }
  }
  /** Show the room a fixture goes in, and wait for a click there to put it down. */
  /** Model the next placed fixture with AI as soon as it is saved: a shape the fitter draws poorly. */
  const sculptNext = useRef(false);
  function startPlacing(next: FixturePlacing, { sculpt = false }: { sculpt?: boolean } = {}) {
    sculptNext.current = sculpt;
    setPlacing(next);
    setWorkScene(next.scene);
    setIsoPanel('room');
    if (stageView === 'photo') setStageView('iso');
    setMessage(
      `Click where the ${next.label.toLowerCase()} stands: on a surface or the floor. Esc cancels.`,
    );
  }
  /**
   * Save a placed fixture with some of it changed by hand: where it stands,
   * its size, or handing its place back to scans. Moving it keeps its
   * footprint's centre on the point, on that surface or the floor.
   */
  /** Whether a fixture is being shown in the room's own view, apart from its office desk. */
  const inRoomViewOf = useCallback(
    (f: Pick<Fixture, 'scene'>) =>
      workScene === 'custom' &&
      f.scene === 'custom' &&
      Boolean(memory?.scene && closeViewOf(memory.scene)),
    [workScene, memory?.scene],
  );
  async function updateFixture(
    id: string,
    change: {
      centre?: { x: number; y: number };
      surfaceId?: string | null;
      size?: FixtureInput['size'];
      scanned?: boolean;
      /** Null puts it back where the desk's camera puts it, in the room's view too. */
      room?: null;
    },
    done: string,
  ) {
    const f = memory?.fixtures?.find((x) => x.id === id);
    if (!f) return;
    const next: FixtureInput = {
      ...fixtureInput(f),
      ...(change.size ? { size: change.size } : {}),
      ...(change.room === null ? { room: null } : {}),
    };
    // The room's own view of a room with an office desk keeps its own place for it.
    const roomView = inRoomViewOf(f);
    const here = roomView ? inRoomView(f) : f;
    if (change.centre || change.surfaceId !== undefined || change.size) {
      const { at, size } = fixtureBox(here, memory?.scene);
      const centre = change.centre ?? { x: at.x + size.w / 2, y: at.y + size.d / 2 };
      const spot = fixtureAt(
        next,
        centre,
        change.surfaceId !== undefined ? change.surfaceId : here.surfaceId,
        memory?.scene ?? null,
      );
      if (spot && roomView) next.room = spot;
      else if (spot) Object.assign(next, spot);
    }
    setError('');
    try {
      const m = await api('fixtures/save', {
        mode,
        fixture: { ...next, ...(change.scanned ? { scanned: true } : {}) },
      });
      setMemory(m);
      setMessage(done);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be saved.');
    }
  }
  /** Remove fixtures; "Not a fixture" (`dismiss`) also tells scans to skip things named like them. */
  async function deleteFixtures(ids: string[], dismiss = false) {
    const gone = (memory?.fixtures ?? []).filter((f) => ids.includes(f.id));
    if (!gone.length) return;
    setError('');
    try {
      const m = await api('fixtures/delete', {
        mode,
        fixtureIds: gone.map((f) => f.id),
        ...(dismiss ? { dismiss: true } : {}),
      });
      setMemory(m);
      if (selection?.kind === 'fixture' && ids.includes(selection.id)) setSelection(null);
      const undoKeys = SHORTCUTS.find((k) => k.action === 'undo')!.keys;
      setMessage(
        (gone.length === 1
          ? `Removed the ${gone[0]!.label.toLowerCase()}.`
          : `Removed ${gone.length} fixtures.`) +
          (dismiss ? ' Scans will skip things named like it.' : '') +
          ` Undo with ${undoKeys}.`,
      );
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be removed.');
    }
  }
  /** Save the fixture being placed where the person clicked, and select it. */
  async function placeFixture(where: { at: { x: number; y: number }; surfaceId: string | null }) {
    if (!placing) return;
    setError('');
    try {
      const m = await api('fixtures/save', {
        mode,
        fixture: { ...placing, ...where },
      });
      setMemory(m);
      setPlacing(null);
      const saved = placing.id ? m.fixtures?.find((f) => f.id === placing.id) : m.fixtures?.at(-1);
      setMessage(`${placing.id ? 'Moved' : 'Placed'} the ${placing.label.toLowerCase()}.`);
      if (saved) setSelection({ kind: 'fixture', id: saved.id });
      void refresh().catch(() => {});
      if (sculptNext.current && saved && !placing.id) {
        sculptNext.current = false;
        void sculptFixture(saved.id, undefined, m);
      }
    } catch (e) {
      setError(e instanceof Error ? e : 'The fixture could not be placed.');
    }
  }
  return useStableSlice(
    {
      addFixturePhoto,
      anchorFixture,
      chooseFixtureDraft,
      deleteFixtures,
      findFixture,
      findOnDesk,
      illustrate,
      inRoomViewOf,
      outlineFixture,
      placeFixture,
      refineFixture3d,
      scanFixtures,
      sculptFixture,
      separate,
      startPlacing,
      untrackFixture,
      updateFixture,
    },
    ['inRoomViewOf'],
  );
}
/** What the Fixtures slice of the lab offers: its state, derived values and actions. */
export interface FixturesSlice {
  addFixturePhoto: (id: string, imageDataUrl?: string) => Promise<void>;
  anchorFixture: (id: string, detectionId: string) => Promise<void>;
  chooseFixtureDraft: (id: string, draft: number) => Promise<void>;
  deleteFixtures: (ids: string[], dismiss?: boolean) => Promise<void>;
  findFixture: (id: string) => Promise<void>;
  findOnDesk: (scene: IsoSceneKind | 'custom') => Promise<void>;
  illustrate: (view?: 'room' | 'desk', note?: string) => Promise<void>;
  inRoomViewOf: (f: Pick<Fixture, 'scene'>) => boolean;
  outlineFixture: (
    id: string,
    drawn: { shape: SelectionShape; held: string | null },
    sam?: boolean,
  ) => Promise<void>;
  placeFixture: (where: {
    at: {
      x: number;
      y: number;
    };
    surfaceId: string | null;
  }) => Promise<void>;
  refineFixture3d: (id: string) => Promise<void>;
  scanFixtures: (
    scene: IsoSceneKind | 'custom',
    replace: boolean,
    addNew: boolean,
  ) => Promise<MappedThing[] | null>;
  sculptFixture: (id: string, note?: string, saved?: DeskMemory) => Promise<void>;
  separate: (back?: boolean) => Promise<void>;
  startPlacing: (
    next: FixturePlacing,
    {
      sculpt,
    }?: {
      sculpt?: boolean;
    },
  ) => void;
  untrackFixture: (id: string) => Promise<void>;
  updateFixture: (
    id: string,
    change: {
      centre?: {
        x: number;
        y: number;
      };
      surfaceId?: string | null;
      size?: FixtureInput['size'];
      scanned?: boolean;
      /** Null puts it back where the desk's camera puts it, in the room's view too. */
      room?: null;
    },
    done: string,
  ) => Promise<void>;
}
