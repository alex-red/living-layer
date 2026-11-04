import { useEffect, useState } from 'react';
import { ISO_PRESETS, THING_ZONE, ruleActions } from '@livinglayer/domain';
import { api } from '../../api';
import type { RuleDraft } from '../../iso/IsoView';
import {
  roomOf,
  sceneProgress,
  selectionForStep,
  viewLabel,
  viewOf,
  type Selection,
  type StepId,
  type WorkScene,
} from '../progress';
import { sceneOf } from '../labels';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import type { DeskSlice } from './desk';
import type { FollowStateSlice } from './follow-state';
import type { CameraSlice } from './camera';
import type { ObservationSlice } from './observation';
import type { TrackingSlice } from './tracking';
import { useStableSlice } from './stable';

/** The Navigation slice of the lab's state. */
export function useNavigationSlice(
  deps: ViewSlice &
    FeedbackSlice &
    RunLogSlice &
    DeskSlice &
    FollowStateSlice &
    CameraSlice &
    ObservationSlice &
    TrackingSlice,
): NavigationSlice {
  const {
    changeMode,
    entities,
    image,
    isoPanel,
    memory,
    mode,
    progress,
    refresh,
    setBoxing,
    setChoosingScene,
    setDrawing,
    setError,
    setGuess,
    setIsoPanel,
    setIsoSurfaceId,
    setMessage,
    setModelOf,
    setOutlineOpen,
    setPlacing,
    setRuleDraft,
    setSelected,
    setSelection,
    setStageView,
    setWorkScene,
    stageView,
    workScene,
  } = deps;
  const sceneLabel =
    workScene === 'custom'
      ? (memory?.scene?.label ?? 'Custom')
      : workScene === 'custom-desk'
        ? viewLabel(workScene)
        : workScene && ISO_PRESETS[workScene].label;
  // A removed custom scene, or one this mode doesn't have, means choosing again;
  // a room whose desk was taken out has no desk view left.
  useEffect(() => {
    if ((workScene === 'custom' || workScene === 'custom-desk') && memory && !memory.scene)
      setWorkScene(null);
    else if (workScene === 'custom-desk' && memory && !viewOf('custom', memory))
      setWorkScene('custom');
  }, [workScene, memory, setWorkScene]);
  /** Choose the room to work in: the demo preset, or start drafting one from a photo. */
  function pickScene(next: WorkScene, from: 'preset' | 'photo' = 'preset') {
    setWorkScene(next);
    setChoosingScene(false);
    setError('');
    setGuess(null);
    setRuleDraft(null);
    if (from === 'photo') {
      setStageView('iso');
      setIsoPanel('scene');
      setSelection({ kind: 'room' });
      setMessage(
        mode === 'demo'
          ? 'Draft the room from the demo photo, review it, then save.'
          : 'Upload a photo of the room. Spark lists what is in it and SAM outlines it.',
      );
      return;
    }
    setIsoPanel('room');
    const after = sceneProgress({ mode, workScene: next, memory });
    setSelection(after.next ? selectionForStep(after.next, memory) : { kind: 'room' });
    const label =
      next === 'custom'
        ? 'your own scene'
        : `the ${(next === 'custom-desk' ? viewLabel(next) : ISO_PRESETS[next].label).toLowerCase()}`;
    setMessage(
      after.next === 'desk'
        ? `Working in ${label}. Next, get close to the desk and pin its top.`
        : `Working in ${label}. Next, find the mug on the desk.`,
    );
  }
  /** Leave the demo to draft the office from a photo of your own: Live, then the photo draft. */
  function draftOwnPhoto() {
    if (mode !== 'live') changeMode('live');
    pickScene('office', 'photo');
    setMessage(
      'Live: upload a photo of your office. Spark lists what is in it and SAM outlines it.',
    );
  }
  /** Show one node of the outline, and move the canvas to the scene it is in. */
  function select(next: Selection | null) {
    setOutlineOpen(false);
    if (next?.kind !== 'new-rule') setRuleDraft(null);
    if (next?.kind !== 'new-fixture' && next?.kind !== 'new-member' && next?.kind !== 'fixture')
      setPlacing(null);
    if (next?.kind !== 'new-fixture') setBoxing(null);
    if (next?.kind === 'lamp' || next?.kind === 'built-in')
      setWorkScene(next.id.split('~')[0] as WorkScene);
    if (next?.kind === 'fixture') {
      const f = memory?.fixtures?.find((x) => x.id === next.id);
      if (f) setWorkScene(f.scene);
    }
    if (next?.kind === 'room' && progress.room) setWorkScene(progress.room);
    if (next?.kind === 'view' && progress.view) setWorkScene(progress.view);
    if (next?.kind === 'surface') {
      setIsoSurfaceId(next.id);
      const inView =
        progress.view && sceneOf(progress.view, memory)?.surfaces.some((x) => x.id === next.id);
      if (progress.room) setWorkScene(inView ? progress.view! : progress.room);
    }
    if (isoPanel === 'scene' && next?.kind !== 'room') setIsoPanel('room');
    if (isoPanel === 'item' && next?.kind !== 'object' && next?.kind !== 'fixture')
      setIsoPanel('room');
    setSelection(next);
  }
  function goToStep(id: StepId) {
    // A room already set up opens; only before one is there does the step choose.
    if (id === 'office' && !workScene) return setChoosingScene(true);
    select(selectionForStep(id, memory));
  }
  /** Open an object's model in the canvas. `undefined` is the mug. */
  function openModel(objectId?: string) {
    setModelOf(objectId);
    setIsoPanel('item');
    if (stageView === 'photo') setStageView('iso');
  }
  function editLayout() {
    // A desk view edits the room through itself (`SceneView`).
    setIsoPanel('scene');
    if (stageView === 'photo') setStageView('iso');
  }
  /** Set up a rule counting one thing, or anything the camera follows. */
  function startRule(objectId?: string) {
    // A name to start from, so the zone can be saved as soon as it is drawn.
    const taken = new Set(memory?.rules?.map((r) => r.label));
    let n = (memory?.rules?.length ?? 0) + 1;
    while (taken.has(`Zone ${n}`)) n++;
    openRule({
      objects: objectId ? [objectId] : 'any',
      actions: lightActions(),
      label: `Zone ${n}`,
      rect: null,
    });
  }
  /** Set up a zone that is a thing: anything stood on it, wherever it is. */
  function startThingZone(thingId: string) {
    const thing = memory?.fixtures?.find((f) => f.id === thingId);
    if (!thing) return;
    openRule({
      objects: 'any',
      actions: lightActions(),
      label: `On the ${thing.label}`.slice(0, 40),
      rect: null,
      anchor: { thingId, padCm: THING_ZONE.padCm },
    });
  }
  /** A zone's light follows it to start with: on when it fills, off when it empties. */
  function lightActions(): RuleDraft['actions'] {
    const light = entities[0];
    return light
      ? {
          onEnter: [{ kind: 'switch', entityId: light, to: 'on' }],
          onLeave: [{ kind: 'switch', entityId: light, to: 'off' }],
        }
      : { onEnter: [], onLeave: [] };
  }
  /** Open a saved rule in the rule builder: its zone dragged again, anything else changed. */
  function editRule(id: string) {
    const r = memory?.rules?.find((x) => x.id === id);
    if (!r) return;
    openRule({
      id: r.id,
      objects: r.objects,
      ...(r.match ? { match: r.match } : {}),
      // An older rule's entity reads as a step each way, and is saved as steps.
      actions: ruleActions(r),
      ...(r.motion ? { motion: r.motion } : {}),
      label: r.label,
      ...(r.anchor
        ? { rect: null, anchor: { thingId: r.anchor.thingId, padCm: r.anchor.padCm } }
        : {
            rect: r.zone.rect,
            ...(r.zone.onSurface ? { onSurface: r.zone.onSurface } : {}),
          }),
    });
  }
  function openRule(draft: RuleDraft) {
    setDrawing(false);
    setRuleDraft(draft);
    setIsoPanel('room');
    // A motion zone is drawn on the camera's picture; any other in the room.
    if (draft.motion ? stageView === 'iso' : stageView === 'photo')
      setStageView(draft.motion ? 'split' : 'iso');
    setSelection({ kind: 'new-rule' });
  }
  const [asking, setAsking] = useState(false);
  /** Ask Spark which preset the photo shows; it may only move between a room and its close view. */
  async function askGuess() {
    if (!workScene) return;
    setAsking(true);
    setError('');
    try {
      const run = await api('scene/classify', {
        mode,
        ...(mode === 'live' ? { imageDataUrl: image } : {}),
      });
      setGuess(run.output);
      const room = roomOf(workScene);
      if (run.output.kind !== workScene && [room, viewOf(room, memory)].includes(run.output.kind))
        setWorkScene(run.output.kind);
      setSelected(run);
      setMessage(`Scene guess saved: ${run.output.kind}. ${run.output.summary}`);
      void refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e : 'Scene guess failed.');
    } finally {
      setAsking(false);
    }
  }
  // A guess for another mode or room no longer applies.
  useEffect(() => setGuess(null), [mode, setGuess]);
  return useStableSlice({
    askGuess,
    asking,
    draftOwnPhoto,
    editLayout,
    editRule,
    goToStep,
    openModel,
    pickScene,
    sceneLabel,
    select,
    startRule,
    startThingZone,
  });
}
/** What the Navigation slice of the lab offers: its state, derived values and actions. */
export interface NavigationSlice {
  askGuess: () => Promise<void>;
  asking: boolean;
  draftOwnPhoto: () => void;
  editLayout: () => void;
  editRule: (id: string) => void;
  goToStep: (id: StepId) => void;
  openModel: (objectId?: string) => void;
  pickScene: (next: WorkScene, from?: 'preset' | 'photo') => void;
  sceneLabel: string | null;
  select: (next: Selection | null) => void;
  startRule: (objectId?: string) => void;
  startThingZone: (thingId: string) => void;
}
