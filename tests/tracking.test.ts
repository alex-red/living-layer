import { describe, expect, it } from 'bun:test';
import type { DeskObservation, WatchView } from '@livinglayer/domain';
import { emptyDesk, prefsOf } from '../apps/web/src/session.js';
import { sightings } from '../apps/web/src/TrackingOverlay.js';

const seen = (objectId: string, width = 1280, height = 720): DeskObservation => ({
  id: `obs-${objectId}`,
  objectId,
  segmentRunId: 'run-1',
  detectionId: 'd1',
  observedAt: '2026-10-30T10:00:00.000Z',
  sourceKey: 'camera',
  frame: { width, height },
  box: { x: 128, y: 72, width: 256, height: 144 },
  identity: 'tracked',
});

describe('camera prefs', () => {
  it('keep the camera off and the tracking layer hidden by default', () => {
    expect(prefsOf(undefined)).toMatchObject({ cameraOn: false, tracking: false });
  });
  it('keep saved camera choices and drop the wrong kind', () => {
    expect(prefsOf({ cameraOn: true, tracking: true })).toMatchObject({
      cameraOn: true,
      tracking: true,
    });
    expect(prefsOf({ cameraOn: 'yes' as never })).toMatchObject({ cameraOn: false });
  });
  it('keep the canvas tool, the iso editor and its subject, and drop unknown values', () => {
    expect(prefsOf(undefined)).toMatchObject({
      tool: 'select',
      isoPanel: 'room',
      modelOf: '',
      isoSurfaceId: '',
      outlineOpen: false,
    });
    expect(
      prefsOf({ tool: 'hand', isoPanel: 'item', modelOf: 'book-1', isoSurfaceId: 'desk:top' }),
    ).toMatchObject({
      tool: 'hand',
      isoPanel: 'item',
      modelOf: 'book-1',
      isoSurfaceId: 'desk:top',
    });
    expect(prefsOf({ tool: 'lasso' as never, isoPanel: 'paint' as never })).toMatchObject({
      tool: 'select',
      isoPanel: 'room',
    });
  });
});

describe('tracking overlay sightings', () => {
  const memory = {
    ...emptyDesk('live'),
    object: { id: 'mug-1', label: 'Mug', createdAt: '2026-10-30T10:00:00.000Z' },
    observation: seen('mug-1'),
    others: [
      {
        id: 'book-1',
        label: 'Book',
        concept: 'book',
        createdAt: '2026-10-30T10:00:00.000Z',
        observation: seen('book-1', 640, 480),
      },
    ],
  };
  it('puts remembered sightings in shares of their frame, skipping other frame shapes', () => {
    const out = sightings({ memory, aspect: 16 / 9 });
    expect(out.map((s) => s.id)).toEqual(['mug-1']);
    expect(out[0]).toMatchObject({
      tone: 'sam',
      box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    });
  });
  it('prefers what the watcher follows now over the remembered sighting', () => {
    const watch = {
      on: true,
      things: [
        {
          id: 'mug-1',
          kind: 'mug',
          label: 'Mug',
          status: 'unsure',
          layer: 'local',
          box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
          score: 0.4,
        },
      ],
    } as WatchView;
    const out = sightings({ memory, watch, aspect: 16 / 9 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tone: 'unsure', note: 'UNSURE', box: { x: 0.5 } });
  });
});
