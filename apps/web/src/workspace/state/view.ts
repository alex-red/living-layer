import { useRef, useState } from 'react';
import type {
  Mode,
  ZoneRect,
  DemoPosition,
  IsoSceneKind,
  Quad,
  SceneGuess,
} from '@livinglayer/domain';
import { DEMO_POSITIONS } from '@livinglayer/domain';
import type { DraftZone, FixturePlacing, IsoPanel, RuleDraft } from '../../iso/IsoView';
import type { CalibrationDraft } from '../../iso/RoomCalibrate';
import { prefsOf, readSession, type StageView } from '../../session';
import { parseSelection, selectionHash, type Selection, type WorkScene } from '../progress';
import type { Tool } from '../ToolStrip';

/** The View slice of the lab's state. */
export function useViewSlice() {
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
  return {
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
    tool,
    workScene,
    zoneStart,
    zooming,
    setTool: chooseTool,
  };
}
export type ViewSlice = ReturnType<typeof useViewSlice>;
