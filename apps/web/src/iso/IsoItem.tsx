import { toIso, type IsoItem, type IsoVec } from '@livinglayer/domain';
import { itemSprite } from './sprites';

/**
 * An item model drawn by the voxel kernel as one pixel-art sprite, with item
 * space placed at `origin` and one item unit drawn `scale` tiles wide. The
 * parts it was built from are listed on the group for tools and tests.
 */
export function ItemSprite({
  item,
  origin,
  scale,
  selected,
  resolution = 32,
}: {
  item: IsoItem;
  origin: IsoVec;
  scale: number;
  /** A part to outline, for the editor. */
  selected?: string;
  /** Voxels along the model's longest side: 32 in the room, 64 for close-ups. */
  resolution?: number;
}) {
  const index = item.parts.findIndex((p) => p.id === selected);
  const sprite = itemSprite(item, {
    scale,
    resolution,
    ...(index >= 0 ? { select: index } : {}),
  });
  const at = toIso(origin);
  return (
    <g
      className="iso-item"
      data-parts={item.parts.map((p) => p.id).join(' ')}
      data-colors={item.parts.map((p) => p.color).join(' ')}
    >
      <image
        href={sprite.url}
        x={at.sx + sprite.x}
        y={at.sy + sprite.y}
        width={sprite.width}
        height={sprite.height}
        preserveAspectRatio="none"
      />
    </g>
  );
}
