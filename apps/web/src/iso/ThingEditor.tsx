import { lazy, useState } from 'react';
import {
  fixtureInput,
  modelTarget,
  runOutput,
  type DeskMemory,
  type EvidenceRun,
  type SavedItem,
} from '@livinglayer/domain';
import { apiAt } from '../api';
import { Later } from '../Later';
import { SculptFixture } from '../workspace/FixturePanel';
import {
  useCamera,
  useDesk,
  useFeedback,
  useLabParts,
  useRunLog,
  useView,
} from '../workspace/LabContext';

const ItemEditor = lazy(() => import('./ItemEditor').then((m) => ({ default: m.ItemEditor })));

/**
 * The Fixture Studio on one thing, wired to the server: its model, its states
 * and its size saved as they change. The room's item panel and the /studio
 * page both show it. `objectId` absent is the mug.
 */
export function ThingEditor({ objectId }: { objectId: string | undefined }) {
  const lab = useLabParts(useView(), useFeedback(), useRunLog(), useDesk(), useCamera());
  const { mode, memory, setMemory, setSelected, setMessage, setError, refresh } = lab;
  const [asking, setAsking] = useState(false);
  const target = memory ? modelTarget(memory, objectId) : null;
  const targetFixture = target?.fixture
    ? memory?.fixtures?.find((f) => f.id === target.id)
    : undefined;
  // A thing the camera follows is modelled with AI from its last sighting, as a fixture is from its photo.
  const sighted = target
    ? memory?.fixtures?.find((f) => f.id === target.id && f.place === 'sightings')
    : undefined;
  // A running camera doesn't block the editor: it captures its frame from it.
  const off = Boolean(lab.busy) || lab.cameraPending || asking;
  const which = objectId ? { objectId } : {};

  async function send<T>(path: string, body: object, done: (r: T) => void) {
    setAsking(true);
    try {
      done(await apiAt<T>(path, { mode, ...body }));
    } catch (e) {
      setError(e instanceof Error ? e : 'The request failed.');
    } finally {
      setAsking(false);
    }
  }
  function onRun(run: EvidenceRun) {
    setSelected(run);
    const item = runOutput(run, 'item');
    setMessage(item ? `Model drafted: ${item.parts.length} parts. Edit it, then save.` : 'Saved.');
    void refresh();
  }

  return (
    <Later>
      <ItemEditor
        key={target?.id}
        item={target?.item}
        fixture={targetFixture}
        label={target?.label ?? 'thing'}
        busy={off}
        fitNote={
          mode === 'demo'
            ? 'Demo: fits the demo mug’s own pixels, from a close photo of it.'
            : 'Free: the fitter measures its shape, colours and print from the same masked crop, on this machine.'
        }
        modelWithAi={sighted && <SculptFixture fixture={sighted} disabled={off} />}
        cropUrl={
          target?.item?.fit?.crop
            ? `/api/item/crop?mode=${mode}${objectId ? `&objectId=${objectId}` : ''}&v=${encodeURIComponent(target.item.fit.crop)}`
            : null
        }
        onRefit={(item) => void send<DeskMemory>('item/refit', { item, ...which }, setMemory)}
        onDraft={
          target?.fixture
            ? undefined
            : () =>
                void send<{ run: EvidenceRun<SavedItem>; memory: DeskMemory }>(
                  'item/draft',
                  { source: 'sampled', ...which },
                  (r) => {
                    setMemory(r.memory);
                    onRun(r.run);
                  },
                )
        }
        onSave={(item) => void send<DeskMemory>('item/save', { item, ...which }, setMemory)}
        onFixtureState={
          targetFixture
            ? (payload) =>
                void send<DeskMemory>(
                  'fixtures/state',
                  { fixtureId: targetFixture.id, ...payload },
                  setMemory,
                )
            : undefined
        }
        onFixtureSize={
          targetFixture
            ? (size) =>
                void send<DeskMemory>(
                  'fixtures/save',
                  { fixture: { ...fixtureInput(targetFixture), size } },
                  setMemory,
                )
            : undefined
        }
      />
    </Later>
  );
}
