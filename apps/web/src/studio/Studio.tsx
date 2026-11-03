import { useEffect, useState } from 'react';
import {
  ITEM_SPRITES,
  modelTarget,
  mugOf,
  type DeskMemory,
  type Fixture,
} from '@livinglayer/domain';
import { ProviderActivity } from '../ProviderUi';
import { ThingEditor } from '../iso/ThingEditor';
import { useItemSprite } from '../iso/sprites';
import { AiTaskDialog } from '../workspace/AiTaskDialog';
import { useDesk, useFeedback, useLabParts, useView } from '../workspace/LabContext';
import { LabProvider } from '../workspace/LabProvider';
import { TopBar } from '../workspace/TopBar';
import '../iso/iso.css';
import '../workspace/workspace.css';
import '../workspace/shell.css';
import './studio.css';

/**
 * The Fixture Studio as a page of its own: every thing in the desk memory on
 * the left, the room's model editor on the right. It runs the same lab state
 * as the workspace, so a save here is the room's, and `?thing=<id>` opens one.
 */
export function Studio() {
  return (
    <LabProvider>
      <StudioShell />
      <ProviderActivity />
      <AiTaskDialog />
    </LabProvider>
  );
}

function StudioShell() {
  const lab = useLabParts(useView(), useFeedback(), useDesk());
  const { memory, modelOf, setModelOf } = lab;
  // The link's thing first, read before the URL starts following the choice (so a reload keeps it).
  const [asked] = useState(() => new URLSearchParams(window.location.search).get('thing'));
  useEffect(() => {
    if (asked) setModelOf(asked);
  }, [asked, setModelOf]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (modelOf) url.searchParams.set('thing', modelOf);
    else url.searchParams.delete('thing');
    window.history.replaceState(null, '', url);
  }, [modelOf]);
  const things = memory ? studioThings(memory) : [];
  const mug = memory ? mugOf(memory) : undefined;
  // No id is the mug, as the room's editor has it.
  const chosen = modelOf ?? mug?.id;
  const current = things.find((f) => f.id === chosen);
  return (
    <div className={`shell lamp-${lab.lamp}`}>
      <TopBar place={['Fixture Studio', ...(current ? [current.label] : [])]} />
      <main className="studio-page">
        <nav className="studio-things" aria-label="Things">
          <span className="tiny">THINGS</span>
          {things.length === 0 ? (
            <p className="micro">
              Nothing to model yet. Add a thing in the <a href="/">room</a> first.
            </p>
          ) : (
            <ul>
              {things.map((f) => (
                <li key={f.id}>
                  <button
                    className={f.id === chosen ? 'active' : ''}
                    aria-current={f.id === chosen ? 'true' : undefined}
                    onClick={() => setModelOf(f.id === mug?.id ? undefined : f.id)}
                  >
                    <ThingThumb memory={memory!} id={f.id} />
                    <span className="studio-thing-name">{f.label}</span>
                    <span className="micro">
                      {f.place === 'sightings' ? 'followed' : (f.state ?? 'placed')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <a className="text-button" href="/">
            ← Back to the room
          </a>
        </nav>
        <section className="iso-frame editing studio-editor" aria-label="Model editor">
          {current ? (
            <ThingEditor objectId={chosen === mug?.id ? undefined : chosen} />
          ) : (
            <p className="micro">Choose a thing to edit its model.</p>
          )}
        </section>
      </main>
    </div>
  );
}

/** Each thing once: one seen in several scenes is linked, and is the same model. */
function studioThings(memory: DeskMemory): Fixture[] {
  const seen = new Set<string>();
  return (memory.fixtures ?? [])
    .filter((f) => {
      const key = f.link ?? f.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function ThingThumb({ memory, id }: { memory: DeskMemory; id: string }) {
  const model = modelTarget(memory, id)?.item ?? null;
  const thumb = useItemSprite(model, ITEM_SPRITES.thumb);
  return thumb ? (
    <img className="studio-thing-thumb" src={thumb.url} alt="" />
  ) : (
    <span className="studio-thing-thumb" />
  );
}
