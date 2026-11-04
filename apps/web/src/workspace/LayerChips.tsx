import { useRef, useState } from 'react';
import { CAMERA_FILTERS, cameraFilterMenu } from './cameraFilter';
import { ContextMenu, type MenuItem } from './ContextMenu';
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
  /** Its chip opens this menu rather than switching it, and names what it shows while on. */
  menu?: { items: MenuItem[]; detail: string };
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
    // In the room always (food's use-by days need no camera); over the camera once some thing keeps a stat.
    {
      name: 'Stats',
      hint: 'Each thing’s stats and use-by day, in cards beside the room and over the camera',
      on: lab.showStats,
      set: lab.setShowStats,
      views:
        lab.camera && Object.keys(lab.memory?.thingStats ?? {}).length
          ? (['photo', 'iso'] as const)
          : (['iso'] as const),
    },
    {
      name: 'Tracking',
      hint: 'Tracked objects and fixtures over the live camera',
      on: lab.tracking,
      set: lab.setTracking,
      // It draws only over a running camera.
      views: lab.camera ? ['photo'] : [],
    },
    {
      name: 'Filter',
      hint: 'A look laid over the live camera, for your eyes only: scans and tracking read the plain frames',
      on: lab.cameraFilter,
      set: lab.setCameraFilter,
      // It filters only a running camera's picture.
      views: lab.camera ? ['photo'] : [],
      menu: {
        detail: CAMERA_FILTERS[lab.cameraFilterKind].label,
        items: cameraFilterMenu(lab.cameraFilter, lab.cameraFilterKind, {
          choose: (kind) => {
            lab.setCameraFilterKind(kind);
            lab.setCameraFilter(true);
          },
          off: () => lab.setCameraFilter(false),
        }),
      },
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
  // The layer whose chip's menu is open, and where: just above the chip.
  const [menu, setMenu] = useState<{ name: string; at: { x: number; y: number } } | null>(null);
  // A press on the open menu's chip closes the menu (a press outside it) before the click lands:
  // that click only closes it. Read at the press, before the menu's close re-renders.
  const pressedOpen = useRef(false);
  if (!layers.length) return null;
  const open = menu && layers.find((l) => l.name === menu.name)?.menu;
  return (
    <div
      className={`layer-chips ${view}`}
      role="group"
      aria-label={view === 'photo' ? 'Layers on the photo' : 'Layers in the room'}
    >
      {layers.map((l) =>
        l.menu ? (
          <button
            key={l.name}
            type="button"
            className="layer-chip"
            data-on={l.on ? '' : undefined}
            aria-haspopup="menu"
            aria-expanded={menu?.name === l.name}
            title={l.hint}
            onPointerDown={() => {
              pressedOpen.current = menu?.name === l.name;
            }}
            onClick={(e) => {
              if (pressedOpen.current) {
                pressedOpen.current = false;
                return setMenu(null);
              }
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ name: l.name, at: { x: r.left, y: r.top - 6 } });
            }}
          >
            {l.name}
            {l.on && <span className="layer-chip-detail"> · {l.menu.detail}</span>}
            <span aria-hidden="true"> ▾</span>
          </button>
        ) : (
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
        ),
      )}
      {menu && open && (
        <ContextMenu
          above
          at={menu.at}
          label={menu.name}
          items={open.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
