import { ISO_TILE, roomSpriteLook, toIso, type IsoItem, type IsoVec } from '@livinglayer/domain';
import { memo } from 'react';
import { useZoomStep } from '../ZoomPan';
import { useItemSprite } from './sprites';

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
   * thing in the room (`roomSpriteLook`).
   */
  resolution?: number;
  /** Warm light cast when a lamp fixture is on. */
  glow?: boolean;
}) {
  const index = item.parts.findIndex((p) => p.id === selected);
  const zoom = useZoomStep();
  const look =
    resolution === undefined
      ? roomSpriteLook(item.parts, scale * ISO_TILE.width, zoom)
      : { resolution };
  const sprite = useItemSprite(item, {
    scale,
    ...look,
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
