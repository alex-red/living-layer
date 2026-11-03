import { useCamera, useDesk, useLabParts, useView } from './LabContext';
import './layer-chips.css';

type LayerView = 'photo' | 'iso';
interface Layer {
  name: string;
  hint: string;
  on: boolean;
  set: (on: boolean) => void;
  /** The views it draws in, where it gets a chip. */
  views: readonly LayerView[];
}

/** Whether the room has a picture, which offers the Picture layer. */
export function usePicture(): boolean {
  const { memory } = useDesk();
  return Boolean(memory?.illustration || memory?.deskIllustration);
}

/** The canvas's layers: each one's switch, and where it draws. */
export function useLayers(): Layer[] {
  const lab = useLabParts(useView(), useDesk(), useCamera());
  const picture = usePicture();
  const calibration = lab.memory?.camera ?? null;
  return [
    {
      name: 'Masks',
      hint: 'What SAM outlined in this frame',
      on: lab.overlay,
      set: lab.setOverlay,
      views: ['photo'],
    },
    {
      name: 'Trail',
      hint: 'Where the mug has been',
      on: lab.showTrail,
      set: lab.setShowTrail,
      views: ['photo', 'iso'],
    },
    {
      name: 'Zones',
      hint: 'Saved zones, on the photo and in the room',
      on: lab.showZones,
      set: lab.setShowZones,
      views: ['photo', 'iso'],
    },
    {
      name: 'Tracking',
      hint: 'Tracked objects and fixtures over the live camera',
      on: lab.tracking,
      set: lab.setTracking,
      // It draws only over a running camera.
      views: lab.camera ? ['photo'] : [],
    },
    ...(picture
      ? [
          {
            name: 'Picture',
            hint: 'The room as its drawing, not its model',
            on: lab.showPicture,
            set: lab.setShowPicture,
            views: ['iso'] as const,
          },
        ]
      : []),
    ...(calibration
      ? [
          {
            name: 'Corner',
            hint: 'The far corner and walls the room’s camera was calibrated on',
            on: lab.showCorner,
            set: lab.setShowCorner,
            views: ['photo'] as const,
          },
        ]
      : []),
  ];
}

/** One-click switches for the layers a view draws, in its corner. */
export function LayerChips({ view }: { view: LayerView }) {
  const layers = useLayers().filter((l) => l.views.includes(view));
  if (!layers.length) return null;
  return (
    <div
      className={`layer-chips ${view}`}
      role="group"
      aria-label={view === 'photo' ? 'Layers on the photo' : 'Layers in the room'}
    >
      {layers.map((l) => (
        <button
          key={l.name}
          type="button"
          className="layer-chip"
          aria-pressed={l.on}
          title={`${l.on ? 'Hide' : 'Show'}: ${l.hint.toLowerCase()}`}
          onClick={() => l.set(!l.on)}
        >
          {l.name}
        </button>
      ))}
    </div>
  );
}
