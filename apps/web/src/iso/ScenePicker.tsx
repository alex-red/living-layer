import {
  ISO_PRESETS,
  ISO_SCENE_PARENT,
  type IsoSceneKind,
  type IsoScene as Scene,
} from '@livinglayer/domain';
import { IsoScene } from './IsoScene';
import './iso.css';

export type SceneKind = IsoSceneKind | 'custom';

const BLURB: Record<IsoSceneKind, string> = {
  office: 'The whole room: desk, chair, shelf and walls.',
  desk: 'A close view of the office’s desk, from above.',
  fridge: 'The inside of a fridge, shelf by shelf.',
};

/** The rooms, each followed by the close views inside it. */
function ordered(): IsoSceneKind[] {
  const kinds = Object.keys(ISO_PRESETS) as IsoSceneKind[];
  return kinds
    .filter((k) => !ISO_SCENE_PARENT[k])
    .flatMap((room) => [room, ...kinds.filter((k) => ISO_SCENE_PARENT[k] === room)]);
}

/**
 * The first step of the lab: which scene the work is in. Pins, objects and
 * rules are all placed on a surface of this scene.
 */
export function ScenePicker({
  value,
  custom,
  onPick,
}: {
  value: SceneKind | null;
  /** The person's own scene, when one is saved. */
  custom?: Scene | null;
  onPick: (kind: SceneKind) => void;
}) {
  const card = (kind: SceneKind, scene: Scene, blurb: string, within?: string) => (
    <button
      key={kind}
      className={`scene-card ${within ? 'nested' : ''}`}
      aria-label={scene.label}
      aria-pressed={value === kind}
      onClick={() => onPick(kind)}
    >
      <span className="scene-card-art" aria-hidden="true">
        <IsoScene scene={scene} />
      </span>
      <span className="scene-card-text">
        {within && <span className="tiny">IN THE {within.toUpperCase()}</span>}
        <strong>{scene.label}</strong>
        <span>{blurb}</span>
      </span>
    </button>
  );
  return (
    <div className="scene-picker" role="group" aria-label="Choose a scene">
      <div className="scene-picker-head">
        <span className="tiny">STEP 00</span>
        <h3>Which scene are you working on?</h3>
        <p>Pins, objects and rules all live on a surface of this scene. You can change it later.</p>
      </div>
      <div className="scene-cards">
        {ordered().map((k) => {
          const parent = ISO_SCENE_PARENT[k];
          return card(k, ISO_PRESETS[k], BLURB[k], parent && ISO_PRESETS[parent].label);
        })}
        {custom && card('custom', custom, 'The scene you built or drafted from a photo.')}
      </div>
    </div>
  );
}
