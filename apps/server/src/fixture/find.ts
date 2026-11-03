import { createHash } from 'node:crypto';
import {
  fixturesFindBodySchema,
  DEMO_SURFACE,
  demoSourceKey,
  fixtureInFrame,
  type Detection,
  type Segmentation,
} from '@livinglayer/domain';
import { LabError, liveImage } from '../errors.js';
import { demoPhotoSegmentation } from '../demo.js';
import { samDataUrl, validateImage } from '../images.js';
import { type RouteDeps } from '../route-deps.js';
import { type Parsed } from './shared.js';

/**
 * Look for a fixture in a camera frame, for a person to confirm which
 * outline it is: SAM is pointed at where it should stand, from where the
 * camera last saw it or its place in the room drawn through the pin (one
 * call). The demo picks the render's outlines under that box.
 * Saved as an ordinary segmentation of the fixture's name.
 */
export async function findFixture(
  { store, meta, run }: Pick<RouteDeps, 'store' | 'meta' | 'run'>,
  { mode, id, imageDataUrl }: Parsed<typeof fixturesFindBodySchema>,
) {
  const memory = store.memory(mode);
  const fixture = memory.fixtures?.find((f) => f.id === id);
  if (!fixture)
    throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
  const pin = memory.surface ?? (mode === 'demo' ? DEMO_SURFACE : null);
  if (!pin)
    throw new LabError('fixture_view', 'Pin the desk first, so the camera’s view is known.', 409);
  const expected = fixtureInFrame(fixture, pin, memory.scene ?? null);
  if (!expected)
    throw new LabError(
      'fixture_view',
      `The ${fixture.label.toLowerCase()} stands outside what the pinned camera sees.`,
      409,
    );
  const concept = fixture.label.trim().toLowerCase();
  if (mode === 'live' && !imageDataUrl)
    throw new LabError('fixture_frame', 'Send a camera frame to look in.', 400);
  liveImage(mode, imageDataUrl);
  return run('segment', mode, async (runId) => {
    // Grown by half its size each way: the place is a guess, SAM finds the edge.
    const grow = (b: typeof expected, sx: number, sy: number, w: number, h: number) => {
      const left = Math.max(0, (b.x - b.width / 2) * sx);
      const top = Math.max(0, (b.y - b.height / 2) * sy);
      return {
        left,
        top,
        right: Math.min(w, (b.x + 1.5 * b.width) * sx),
        bottom: Math.min(h, (b.y + 1.5 * b.height) * sy),
      };
    };
    if (mode === 'demo') {
      const photo = await demoPhotoSegmentation();
      const box = grow(expected, 1, 1, photo.frame.width, photo.frame.height);
      const inside = (d: Detection) => {
        const w = Math.min(box.right, d.box.x + d.box.width) - Math.max(box.left, d.box.x);
        const h = Math.min(box.bottom, d.box.y + d.box.height) - Math.max(box.top, d.box.y);
        return (Math.max(0, w) * Math.max(0, h)) / (d.box.width * d.box.height);
      };
      // The desk itself is a surface, never a fixture.
      const detections = photo.detections.filter((d) => d.objectId !== '1' && inside(d) >= 0.5);
      const output: Segmentation = {
        concept,
        frame: photo.frame,
        detections,
        sourceKey: demoSourceKey(),
      };
      return { output };
    }
    const image = await validateImage(imageDataUrl!);
    const box = grow(
      expected,
      image.width / pin.frame.width,
      image.height / pin.frame.height,
      image.width,
      image.height,
    );
    const outlined = await meta.segmentBoxes(
      await samDataUrl(image),
      [{ id: 1, box }],
      image.width,
      image.height,
    );
    return {
      ...outlined,
      output: {
        ...outlined.output,
        concept,
        sourceKey: createHash('sha256').update(image.bytes).digest('hex'),
      },
      assets: [
        store.asset(runId, `source.${image.ext}`, image.bytes),
        store.asset(runId, 'sam-output.txt', outlined.raw),
      ],
    };
  });
}
