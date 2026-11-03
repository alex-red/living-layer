import { ISO_TILE, ITEM_SPRITES, toIso, type IsoItem, type IsoVec } from '@livinglayer/domain';
import { memo } from 'react';
import { useZoomStep } from '../ZoomPan';
import { useItemSprite } from './sprites';

/** The widest a room thing is drawn, in sprite pixels, however far the view zooms. */
const MAX_ROOM_SPRITE_PX = 512;

/**
 * An item model drawn by the voxel kernel as one pixel-art sprite, with item
 * space placed at `origin` and one item unit drawn `scale` tiles wide. The
 * parts it was built from are listed on the group for tools and tests.
 */
export const ItemSprite = memo(ItemSpriteView, sameSprite);

type ItemSpriteProps = Parameters<typeof ItemSpriteView>[0];

/** Callers pass a fresh `origin` each render (a box's corner), so it compares by value. */
function sameSprite(a: ItemSpriteProps, b: ItemSpriteProps): boolean {
  return (
    a.item === b.item &&
    a.scale === b.scale &&
    a.selected === b.selected &&
    a.resolution === b.resolution &&
    a.glow === b.glow &&
    a.origin.x === b.origin.x &&
    a.origin.y === b.origin.y &&
    a.origin.z === b.origin.z
  );
}

function ItemSpriteView({
  item,
  origin,
  scale,
  selected,
  resolution,
  glow,
}: {
  item: IsoItem;
  origin: IsoVec;
  scale: number;
  /** A part to outline, for the editor. */
  selected?: string;
  /**
   * Voxels along the model's longest side: 64 for close-ups. Unset, it is a
   * thing in the room, drawn finer as the view zooms in so its pixels stay
   * about the size they are at fit.
   */
  resolution?: number;
  /** Warm light cast when a lamp fixture is on. */
  glow?: boolean;
}) {
  const index = item.parts.findIndex((p) => p.id === selected);
  const zoom = useZoomStep();
  let detail = 1;
  if (resolution === undefined)
    while (detail < zoom && scale * ISO_TILE.width * detail * 2 <= MAX_ROOM_SPRITE_PX) detail *= 2;
  const sprite = useItemSprite(item, {
    scale,
    resolution: resolution ?? Math.min(64, ITEM_SPRITES.room.resolution * detail),
    ...(detail > 1 ? { pixel: 1 / detail } : {}),
    ...(index >= 0 ? { select: index } : {}),
    ...(glow ? { glow } : {}),
  });
  const at = toIso(origin);
  return (
    <g
      className="iso-item"
      data-parts={item.parts.map((p) => p.id).join(' ')}
      data-colors={item.parts.map((p) => p.color).join(' ')}
    >
      {sprite && (
        <image
          href={sprite.url}
          x={at.sx + sprite.x}
          y={at.sy + sprite.y}
          width={sprite.width}
          height={sprite.height}
          preserveAspectRatio="none"
        />
      )}
    </g>
  );
}
