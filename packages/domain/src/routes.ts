import type { z } from 'zod';
import type { EvidenceRun, imageRequestSchema, LabStatus, Scene, Segmentation } from './api.js';
import type { AssistDraft, SelectResolve } from './assist.js';
import type { CameraView, cameraInputSchema, NetworkStream } from './camera.js';
import type { FixtureDraft } from './fixture.js';
import type { MappedThing, MovingThing } from './fixture-scan.js';
import type { IsoScene } from './iso.js';
import type { SceneGuess } from './iso-presets.js';
import type { SceneDraft } from './iso-templates.js';
import type { DeskMemory, PlacementDecision } from './memory.js';
import type { PhotoDraft } from './photo-scene.js';
import type { SceneFit } from './place-fit.js';
import type * as R from './requests.js';
import type { RoomMarks } from './room-camera.js';
import type { Job } from './item-sculpt.js';
import type { Quad } from './iso.js';
import type { RunOf } from './run-outputs.js';
import type { StatNow, StatsNow, ThingStatsView } from './stats.js';
import type { WatchView } from './watch.js';

/** One entity Home Assistant has that Living Layer could switch, as the lab lists it. */
export interface HaEntity {
  entityId: string;
  name: string;
  domain: 'fan' | 'input_boolean' | 'light' | 'switch';
  state: string;
}
/**
 * The server's websocket to Home Assistant: none (no sign-in), opening,
 * open with every state in hand, refused (the token), or gone (it retries).
 */
export type HaLink = 'off' | 'connecting' | 'connected' | 'unauthorized' | 'unreachable';
/** The devices Living Layer may switch, as Home Assistant reports them now; sent on every change. */
export interface HaView {
  link: HaLink;
  /** Each device's state by entity id; empty unless `link` is `connected`. */
  states: Record<string, string>;
}

/** A phone paired to the lab as a camera, as `/api/remote` shows it. */
interface PairingView {
  url: string;
  /** The QR code for `url`, as SVG markup from the server. */
  qr: string;
  phone: 'waiting' | 'ready';
  stream: NetworkStream | null;
}

/**
 * A request body with one field typed as the page holds it. The schemas check
 * a saved scene or desk as the custom one the server stores; the page passes
 * the `IsoScene` or `DeskMemory` it has, whose `kind` is wider.
 */
type Wide<B, K extends string, V> = Omit<B, K> & { [P in K]: V };
type Image = z.input<typeof imageRequestSchema>;
type CameraInput = z.input<typeof cameraInputSchema>;

/**
 * The routes the web calls, by path under `/api/`: what each takes (`body`;
 * `undefined` when it takes none) and what it answers. The bodies are the
 * server's own request schemas (`requests.ts`, `api.ts`); the answers are named
 * where the server has a type for them, else written here from what the route
 * returns. A path with a `${string}` is one with an id in it.
 */
interface ApiRoutes {
  status: { body: undefined; response: LabStatus };
  runs: { body: undefined; response: EvidenceRun[] };
  jobs: { body: undefined; response: Job[] };
  [path: `jobs/${string}`]: { body: undefined; response: Job };
  [path: `jobs/${string}/stop`]: { body: undefined; response: Job };
  'settings/spend-limit': { body: R.SettingsSpendLimitBody; response: { spendLimit: number } };
  'settings/tracking-ai': { body: R.SettingsTrackingAiBody; response: { on: boolean } };
  saves: { body: undefined; response: R.StoredSave[] };
  'saves/save': { body: R.SavesSaveBody; response: { save: R.StoredSave; saves: R.StoredSave[] } };
  'saves/rename': { body: R.SavesRenameBody; response: R.StoredSave[] };
  'saves/delete': { body: R.SavesDeleteBody; response: R.StoredSave[] };

  'desk/demo': { body: undefined; response: DeskMemory };
  'desk/live': { body: undefined; response: DeskMemory };
  'desk/restore': { body: Wide<R.DeskRestoreBody, 'memory', DeskMemory>; response: DeskMemory };
  'desk/track': {
    body: R.DeskTrackBody;
    response: { memory: DeskMemory; event: EvidenceRun<PlacementDecision> };
  };
  'desk/auto-pin': {
    body: R.DeskAutoPinBody;
    response: {
      run: EvidenceRun<Segmentation> | null;
      pin: { corners: Quad; iou: number; frame: { width: number; height: number } } | null;
    };
  };

  discover: { body: Image; response: EvidenceRun<Scene> };
  segment: { body: R.SegmentBody; response: EvidenceRun<Segmentation> };
  'select/resolve': { body: R.SelectResolveBody; response: SelectResolve };
  assist: { body: R.AssistBody; response: EvidenceRun<AssistDraft> };
  'assist/save': {
    body: R.AssistSaveBody;
    /** The group a model was put in as, or the thing a variant was kept on. */
    response: { memory?: DeskMemory; group?: string; thing?: string };
  };
  watch: { body: R.WatchBody; response: WatchView };
  'things/stats': { body: R.ThingsStatsBody; response: { memory: DeskMemory; stats: StatsNow } };
  'things/learn': { body: R.ThingsLearnBody; response: { now: StatNow; stats: StatsNow } };
  'things/used': { body: R.ThingsUsedBody; response: { now: StatNow; stats: StatsNow } };
  [path: `things/${'demo' | 'live'}/${string}`]: { body: undefined; response: ThingStatsView };
  'watch/demo': { body: R.WatchDemoBody; response: unknown };

  'scene/classify': { body: Image; response: EvidenceRun<SceneGuess> };
  'scene/draft': {
    body: Image;
    response: EvidenceRun<{ draft: SceneDraft; scene: IsoScene }>;
  };
  'scene/from-photo': { body: R.SceneFromPhotoBody; response: EvidenceRun<PhotoDraft> };
  'scene/from-photo/save': {
    body: Wide<R.SceneFromPhotoSaveBody, 'scene', IsoScene>;
    response: DeskMemory;
  };
  'scene/setup': { body: R.SceneSetupBody; response: EvidenceRun<PhotoDraft> };
  'scene/fit': { body: Wide<R.SceneFitBody, 'scene', IsoScene>; response: SceneFit };
  'scene/illustrate': {
    body: R.SceneIllustrateBody;
    response: { run: EvidenceRun; segment: EvidenceRun<Segmentation> | null; memory: DeskMemory };
  };
  'scene/separate': {
    body: R.SceneSeparateBody;
    response: { run: EvidenceRun; memory: DeskMemory; lifted: number; skipped: string[] };
  };
  'scene/separate/undo': { body: R.ModeOnly; response: { memory: DeskMemory } };

  'room/floor': {
    body: R.ModeImage;
    response: {
      run: EvidenceRun<Segmentation>;
      marks: RoomMarks | null;
      frame: { width: number; height: number };
    };
  };
  'room/calibrate': {
    body: R.RoomCalibrateBody;
    response: {
      memory: DeskMemory;
      fit: { error: number; heightCm: number; hfovDeg: number };
    };
  };
  'room/keep': { body: R.ModeImage; response: DeskMemory };
  'room/forget': { body: R.ModeOnly; response: DeskMemory };

  'fixtures/find': { body: R.FixturesFindBody; response: EvidenceRun<Segmentation> };
  'fixtures/draft': {
    body: R.FixturesDraftBody;
    response: { run: EvidenceRun; draft: FixtureDraft };
  };
  'fixtures/choose': { body: R.FixturesChooseBody; response: DeskMemory };
  'fixtures/save': { body: R.FixturesSaveBody; response: DeskMemory };
  'fixtures/promote': {
    body: R.FixturesPromoteBody;
    response: { memory: DeskMemory; fixtureId: string; pictured: boolean };
  };
  'fixtures/delete': { body: R.FixturesDeleteBody; response: DeskMemory };
  'fixtures/anchor': { body: R.FixturesAnchorBody; response: DeskMemory };
  'fixtures/untrack': { body: R.ModeId; response: DeskMemory };
  'fixtures/photo': {
    body: R.FixturesPhotoBody;
    response: { run: EvidenceRun<{ views: number; iou: number }>; memory: DeskMemory };
  };
  'fixtures/scan': {
    body: R.FixturesScanBody;
    response: {
      run: EvidenceRun;
      mapped: MappedThing[];
      memory: DeskMemory;
      moving: MovingThing[];
      /** What it now follows from its outline, and what SAM didn't outline, when asked to follow. */
      followed: string[];
      missed: string[];
    };
  };
  'fixtures/sculpt': {
    body: R.FixturesSculptBody;
    response: { run: RunOf<'fixture'>; memory: DeskMemory };
  };
  'fixtures/refine3d': { body: R.FixturesRefine3dBody; response: unknown };
  'fixtures/sculpt/reapply': {
    body: R.FixturesSculptReapplyBody;
    response: { memory: DeskMemory; fixtureId: string; label: string };
  };

  cameras: { body: undefined; response: { cameras: CameraView[] } };
  'cameras/save': {
    body: CameraInput;
    response: { camera: CameraView; cameras: CameraView[] };
  };
  'cameras/delete': { body: R.CamerasDeleteBody; response: { cameras: CameraView[] } };
  streams: { body: undefined; response: { streams: NetworkStream[] } };
  'streams/crop': { body: R.StreamsCropBody; response: unknown };
  remote: { body: undefined; response: { pairing: PairingView | null } };
  'remote/pair': { body: Record<string, never>; response: { pairing: PairingView | null } };
  'ha/entities': { body: undefined; response: { entities: HaEntity[] } };
}

/** The key of `ApiRoutes` a path names: itself, else the id pattern it fits. */
type ApiRouteKey<P extends string> = P extends keyof ApiRoutes
  ? P
  : { [K in keyof ApiRoutes]: P extends K ? K : never }[keyof ApiRoutes];
/** Every path the table can name, id patterns included. */
export type ApiPath = keyof ApiRoutes | `jobs/${string}` | `jobs/${string}/stop`;
export type ApiBody<P extends string> = ApiRoutes[ApiRouteKey<P>]['body'];
export type ApiResponse<P extends string> = ApiRoutes[ApiRouteKey<P>]['response'];
