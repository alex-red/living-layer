import { useRef, useState } from 'react';
import type {
  Mode,
  ZoneRect,
  DemoPosition,
  IsoSceneKind,
  Quad,
  SceneGuess,
  SelectionShape,
} from '@livinglayer/domain';
import { DEMO_POSITIONS } from '@livinglayer/domain';
import type { DraftZone, FixturePlacing, IsoPanel, RuleDraft } from '../../iso/IsoView';
import type { CalibrationDraft } from '../../iso/RoomCalibrate';
import { prefsOf, readSession, type StageView } from '../../session';
import { parseSelection, selectionHash, type Selection, type WorkScene } from '../progress';
import type { Tool } from '../ToolStrip';
import { useStableSlice } from './stable';
import type { Prefs, SessionSave } from '../../session';
import type { Dispatch, RefObject, SetStateAction } from 'react';

/** The View slice of the lab's state. */
export function useViewSlice(): ViewSlice {
  // The browser's own save: choices and a copy of each desk, read once.
  const [boot] = useState(() => {
    const save = readSession();
    return { save, prefs: prefsOf(save?.prefs) };
  });
  const [mode, setMode] = useState<Mode>(boot.prefs.mode);
  const [draftZone, setDraftZone] = useState<DraftZone>({
    x: 0.3,
    y: 0.2,
    width: 0.4,
    height: 0.6,
  });
  const [drawing, setDrawing] = useState(false);
  const zoneStart = useRef<{ x: number; y: number } | null>(null);
  const [concept, setConcept] = useState(boot.prefs.concept);
  const [demoPosition, setDemoPosition] = useState<DemoPosition>(
    boot.prefs.demoPosition in DEMO_POSITIONS
      ? (boot.prefs.demoPosition as DemoPosition)
      : 'centre',
  );
  const [overlay, setOverlay] = useState(boot.prefs.overlay);
  const [showTrail, setShowTrail] = useState(boot.prefs.trail);
  const [showPicture, setShowPicture] = useState(boot.prefs.picture);
  const [showCorner, setShowCorner] = useState(boot.prefs.corner);
  const [fixtureLook, setFixtureLook] = useState(boot.prefs.fixtureLook);
  const [showZones, setShowZones] = useState(boot.prefs.zones);
  const [stageView, setStageView] = useState<StageView>(boot.prefs.stageView);
  // What a drag on the canvas does.
  const [tool, setTool] = useState<Tool>(boot.prefs.tool);
  /** Choose a canvas tool; the AI brush draws on the camera's picture, so it shows it beside the room. */
  function chooseTool(next: Tool) {
    setTool(next);
    if (next === 'brush') setStageView((v) => (v === 'iso' ? 'split' : v));
  }
  // Scene first: nothing runs until the person says which scene they are in.
  const [workScene, setWorkScene] = useState<WorkScene | null>(boot.prefs.workScene);
  const [choosingScene, setChoosingScene] = useState(false);
  // The outline node the inspector shows. It lives in the URL hash, so a reload keeps it.
  const [selection, setSelectionState] = useState<Selection | null>(() =>
    parseSelection(window.location.hash),
  );
  const setSelection = (next: Selection | null) => {
    setSelectionState(next);
    const hash = selectionHash(next);
    window.history.replaceState(null, '', hash || window.location.pathname);
  };
  // What the iso canvas is doing: showing the room, editing the layout, or editing a model.
  // An editor reopens only beside what it edits: the layout with the room, a model with its thing.
  const [isoPanel, setIsoPanel] = useState<IsoPanel>(() => {
    const kind = selection?.kind;
    const fits =
      boot.prefs.isoPanel === 'scene'
        ? kind === 'room'
        : boot.prefs.isoPanel === 'item'
          ? kind === 'object' || kind === 'fixture'
          : true;
    return fits ? boot.prefs.isoPanel : 'room';
  });
  // On phones the outline is a sheet that slides up over the page.
  const [outlineOpen, setOutlineOpen] = useState(boot.prefs.outlineOpen);
  const [modelOf, setModelOf] = useState<string | undefined>(boot.prefs.modelOf || undefined);
  const [isoSurfaceId, setIsoSurfaceId] = useState<string | undefined>(
    boot.prefs.isoSurfaceId || undefined,
  );
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  /** A fixture waiting for a click in the iso room that says where it stands. */
  const [placing, setPlacing] = useState<FixturePlacing | null>(null);
  /** A box being drawn around a thing on the desk photo, to draft a fixture from. */
  const [boxing, setBoxing] = useState<{ rect: ZoneRect | null } | null>(null);
  /**
   * A box or polygon drawn round a thing on the picture, to outline it on this
   * machine with no model call. `target` names what for (`'object'` for a new
   * one, a fixture's id); `held` is the live frame it was drawn on.
   */
  const [outlining, setOutlining] = useState<{
    target: string;
    shape: SelectionShape | null;
    held: string | null;
  } | null>(null);
  /** Start drawing round a thing on the picture, which the iso view alone hides. */
  function startOutlining(target: string) {
    setOutlining({ target, shape: null, held: null });
    if (stageView === 'iso') setStageView('photo');
  }
  /** A zoomed view being drawn over the live camera, as shares of what it shows now. */
  const [zooming, setZooming] = useState<{ rect: ZoneRect | null } | null>(null);
  const [guess, setGuess] = useState<SceneGuess | null>(null);
  // Clicking a surface's corners on the photo, for the iso view.
  const [calibrating, setCalibrating] = useState<CalibrationDraft | null>(null);
  const [pinning, setPinning] = useState<{
    scene: IsoSceneKind | 'custom';
    surfaceId: string;
    label: string;
    /** Corners found from the photo, to check and adjust instead of clicking. */
    corners?: Quad;
    note?: string;
  } | null>(null);
  const [drawer, setDrawer] = useState(boot.prefs.drawer);
  const [showKeys, setShowKeys] = useState(false);
  return useStableSlice({
    boot,
    boxing,
    calibrating,
    chooseTool,
    choosingScene,
    concept,
    demoPosition,
    draftZone,
    drawer,
    drawing,
    fixtureLook,
    guess,
    isoPanel,
    isoSurfaceId,
    mode,
    modelOf,
    outlineOpen,
    outlining,
    overlay,
    pinning,
    placing,
    ruleDraft,
    selection,
    setBoxing,
    setCalibrating,
    setChoosingScene,
    setConcept,
    setDemoPosition,
    setDraftZone,
    setDrawer,
    setDrawing,
    setFixtureLook,
    setGuess,
    setIsoPanel,
    setIsoSurfaceId,
    setMode,
    setModelOf,
    setOutlineOpen,
    setOutlining,
    setOverlay,
    setPinning,
    setPlacing,
    setRuleDraft,
    setSelection,
    setShowCorner,
    setShowKeys,
    setShowPicture,
    setShowTrail,
    setShowZones,
    setStageView,
    setToolRaw: setTool,
    setWorkScene,
    setZooming,
    showCorner,
    showKeys,
    showPicture,
    showTrail,
    showZones,
    stageView,
    startOutlining,
    tool,
    workScene,
    zoneStart,
    zooming,
    setTool: chooseTool,
  });
}
/** What the View slice of the lab offers: its state, derived values and actions. */
export interface ViewSlice {
  boot: {
    save: SessionSave | null;
    prefs: Prefs;
  };
  boxing: {
    rect: ZoneRect | null;
  } | null;
  calibrating: CalibrationDraft | null;
  chooseTool: (next: Tool) => void;
  choosingScene: boolean;
  concept: string;
  demoPosition: 'centre' | 'front' | 'right';
  draftZone: DraftZone;
  drawer: boolean;
  drawing: boolean;
  fixtureLook: 'model' | 'picture';
  guess: {
    kind: 'desk' | 'fridge' | 'office';
    visibleProps: string[];
    summary: string;
  } | null;
  isoPanel: IsoPanel;
  isoSurfaceId: string | undefined;
  mode: 'demo' | 'live';
  modelOf: string | undefined;
  outlineOpen: boolean;
  outlining: {
    target: string;
    shape: SelectionShape | null;
    held: string | null;
  } | null;
  overlay: boolean;
  pinning: {
    scene: IsoSceneKind | 'custom';
    surfaceId: string;
    label: string;
    /** Corners found from the photo, to check and adjust instead of clicking. */
    corners?: Quad;
    note?: string;
  } | null;
  placing: FixturePlacing | null;
  ruleDraft: RuleDraft | null;
  selection: Selection | null;
  setBoxing: Dispatch<
    SetStateAction<{
      rect: ZoneRect | null;
    } | null>
  >;
  setCalibrating: Dispatch<SetStateAction<CalibrationDraft | null>>;
  setChoosingScene: Dispatch<SetStateAction<boolean>>;
  setConcept: Dispatch<SetStateAction<string>>;
  setDemoPosition: Dispatch<SetStateAction<'centre' | 'front' | 'right'>>;
  setDraftZone: Dispatch<SetStateAction<DraftZone>>;
  setDrawer: Dispatch<SetStateAction<boolean>>;
  setDrawing: Dispatch<SetStateAction<boolean>>;
  setFixtureLook: Dispatch<SetStateAction<'model' | 'picture'>>;
  setGuess: Dispatch<
    SetStateAction<{
      kind: 'desk' | 'fridge' | 'office';
      visibleProps: string[];
      summary: string;
    } | null>
  >;
  setIsoPanel: Dispatch<SetStateAction<IsoPanel>>;
  setIsoSurfaceId: Dispatch<SetStateAction<string | undefined>>;
  setMode: Dispatch<SetStateAction<'demo' | 'live'>>;
  setModelOf: Dispatch<SetStateAction<string | undefined>>;
  setOutlineOpen: Dispatch<SetStateAction<boolean>>;
  setOutlining: Dispatch<
    SetStateAction<{
      target: string;
      shape: SelectionShape | null;
      held: string | null;
    } | null>
  >;
  setOverlay: Dispatch<SetStateAction<boolean>>;
  setPinning: Dispatch<
    SetStateAction<{
      scene: IsoSceneKind | 'custom';
      surfaceId: string;
      label: string;
      /** Corners found from the photo, to check and adjust instead of clicking. */
      corners?: Quad;
      note?: string;
    } | null>
  >;
  setPlacing: Dispatch<SetStateAction<FixturePlacing | null>>;
  setRuleDraft: Dispatch<SetStateAction<RuleDraft | null>>;
  setSelection: (next: Selection | null) => void;
  setShowCorner: Dispatch<SetStateAction<boolean>>;
  setShowKeys: Dispatch<SetStateAction<boolean>>;
  setShowPicture: Dispatch<SetStateAction<boolean>>;
  setShowTrail: Dispatch<SetStateAction<boolean>>;
  setShowZones: Dispatch<SetStateAction<boolean>>;
  setStageView: Dispatch<SetStateAction<StageView>>;
  setToolRaw: Dispatch<SetStateAction<Tool>>;
  setWorkScene: Dispatch<SetStateAction<WorkScene | null>>;
  setZooming: Dispatch<
    SetStateAction<{
      rect: ZoneRect | null;
    } | null>
  >;
  showCorner: boolean;
  showKeys: boolean;
  showPicture: boolean;
  showTrail: boolean;
  showZones: boolean;
  stageView: StageView;
  startOutlining: (target: string) => void;
  tool: Tool;
  workScene: WorkScene | null;
  zoneStart: RefObject<{
    x: number;
    y: number;
  } | null>;
  zooming: {
    rect: ZoneRect | null;
  } | null;
  setTool: (next: Tool) => void;
}
