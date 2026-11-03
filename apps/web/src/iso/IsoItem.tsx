import { toIso, type IsoItem, type IsoVec } from '@livinglayer/domain';
import { useItemSprite } from './sprites';

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
  glow,
}: {
  item: IsoItem;
  origin: IsoVec;
  scale: number;
  /** A part to outline, for the editor. */
  selected?: string;
  /** Voxels along the model's longest side: 32 in the room, 64 for close-ups. */
  resolution?: number;
  /** Warm light cast when a lamp fixture is on. */
  glow?: boolean;
}) {
  const index = item.parts.findIndex((p) => p.id === selected);
  const sprite = useItemSprite(item, {
    scale,
    resolution,
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
