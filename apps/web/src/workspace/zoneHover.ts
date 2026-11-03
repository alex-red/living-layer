import { useEffect, useRef, useState } from 'react';
import type { DeskMemory } from '@livinglayer/domain';

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Size = { width: number; height: number };

/**
 * A point on the stage as shares of the picture. On the camera the picture
 * is fitted into the box like the video's object-fit: contain; a photo is the
 * box. Off the picture, null.
 */
export function pictureShare(client: Point, box: Rect, frame: Size | null): Point | null {
  let { x, y, width, height } = box;
  if (frame) {
    const scale = Math.min(width / frame.width, height / frame.height);
    x += (width - frame.width * scale) / 2;
    y += (height - frame.height * scale) / 2;
    width = frame.width * scale;
    height = frame.height * scale;
  }
  if (!width || !height) return null;
  const p = { x: (client.x - x) / width, y: (client.y - y) / height };
  return p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1 ? null : p;
}

/** Every zone's place, the main one's too, as `zoneAt` reads them. */
export function ruleRects(memory: DeskMemory | null | undefined): { id: string; rect: Rect }[] {
  return (memory?.rules ?? []).map((r) => ({ id: r.id, rect: r.zone.rect }));
}

/** The zone under a point: the smallest that holds it, so one inside another can be reached. */
export function zoneAt<T extends { rect: Rect }>(zones: readonly T[], p: Point | null): T | null {
  if (!p) return null;
  let best: T | null = null;
  for (const z of zones) {
    const { x, y, width, height } = z.rect;
    if (p.x < x || p.x > x + width || p.y < y || p.y > y + height) continue;
    if (!best || width * height < best.rect.width * best.rect.height) best = z;
  }
  return best;
}

/**
 * The id of the zone under the pointer, or null, and the ref for the layer
 * that draws them. It listens on the layer's parent, since zones let presses
 * through to what is under them, and changes only when the zone does.
 */
export function useHoveredZone(
  zones: readonly { id: string; rect: Rect }[],
  frame: Size | null,
): { ref: (el: Element | null) => void; hovered: string | null } {
  const [el, ref] = useState<Element | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const latest = useRef(zones);
  latest.current = zones;
  const width = frame?.width;
  const height = frame?.height;
  useEffect(() => {
    const stage = el?.parentElement;
    if (!stage) return;
    const fit = width && height ? { width, height } : null;
    const move = (e: PointerEvent) => {
      const p = pictureShare({ x: e.clientX, y: e.clientY }, stage.getBoundingClientRect(), fit);
      setHovered(zoneAt(latest.current, p)?.id ?? null);
    };
    const leave = () => setHovered(null);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerleave', leave);
    return () => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerleave', leave);
    };
  }, [el, width, height]);
  return { ref, hovered };
}
