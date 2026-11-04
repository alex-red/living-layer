import { useState } from 'react';
import {
  DEMO_SURFACE,
  layoutThings,
  pinFits,
  type DeskMemory,
  type MappedThing,
  placedFixtures,
} from '@livinglayer/domain';
import { Button, Check, IconButton, Segmented } from '../ui/controls';
import { useCamera, useDesk, useFeedback, useFixtures, useLabParts, useView } from './LabContext';
import { useScenes, type WorkScene } from './fixture-scenes';
import { Cost, Details, useCall } from './panel';

const MATCH_LABEL: Record<MappedThing['match'], string> = {
  existing: 'In the room',
  library: 'From the library',
  fitted: 'Fitted',
  dismissed: 'Skipped',
  placeholder: 'Placeholder',
  new: 'Not added',
};

/**
 * Scan and map the pinned view into the room or its close view: the
 * fixtures already saved, and the things the person's layout draws on the
 * desk, are found and moved to where the camera sees them. Ticked, what the
 * room doesn't have yet is added too, with models fitted to SAM's outlines.
 * Scanning both scenes links each thing across them.
 */
export function ScanFixtures({
  initial,
  open = false,
}: {
  initial: WorkScene | null;
  open?: boolean;
}) {
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useCamera(), useFixtures());
  const { call, off } = useCall();
  const [mapped, setMapped] = useState<MappedThing[] | null>(null);
  const [replace, setReplace] = useState(true);
  const live = lab.mode === 'live';
  // The demo scans its office through the demo camera, whose pin is always the same.
  const pin = live ? lab.memory?.surface : DEMO_SURFACE;
  const scenes = useScenes().filter((s) => pin && pinFits(pin, s.id));
  const [chosen, setChosen] = useState<WorkScene | null>(initial);
  const scene = scenes.find((s) => s.id === chosen)?.id ?? scenes[0]?.id ?? null;
  // A drafted room can be scanned from the photo it was drafted from.
  const roomPhoto =
    pin?.scene === 'custom' && Boolean(lab.memory?.scenePhoto || lab.memory?.illustration);
  const blocked = (live && !lab.image && !lab.camera && !roomPhoto) || !scene;
  const inScene = placedFixtures(lab.memory).filter((f) => f.scene === scene);
  const drawn = scene === 'custom' && lab.memory?.scene ? layoutThings(lab.memory.scene) : [];
  const placedByHand = inScene.some((f) => !f.scanned) || drawn.length > 0;
  // With nothing in the room to look for, the scan can only add.
  const known = inScene.length + drawn.length > 0;
  const [addNew, setAddNew] = useState(false);
  const adding = addNew || !known;
  return (
    <Details summary="Scan and map fixtures" open={open}>
      <p className="micro">
        {live
          ? `Spark finds the room’s fixtures and desk things in ${lab.camera ? 'what the camera shows' : lab.image ? 'the desk photo' : 'the room’s photo'}, SAM outlines each one, and each moves to where it stands.${adding ? ' New ones are modelled and added.' : ''}`
          : `Scans the demo office, no model calls. The room’s fixtures move to where they stand.${adding ? ' New ones are modelled and added.' : ''}`}
      </p>
      {scenes.length > 1 && (
        <Segmented
          label="Scene to map into"
          value={scene ?? ''}
          onChange={(id) => setChosen(id as WorkScene)}
          options={scenes.map((s) => ({ value: s.id, label: s.label }))}
        />
      )}
      <Button
        disabled={off || blocked}
        title={blocked ? (scene ? 'Add a desk photo first.' : 'Pin a surface first.') : undefined}
        onClick={() =>
          void lab.scanFixtures(scene!, replace, adding).then((m) => {
            if (m) setMapped(m);
          })
        }
      >
        {lab.busy === 'scan'
          ? 'Scanning…'
          : inScene.some((f) => f.scanned)
            ? 'Scan again'
            : 'Scan and map'}
      </Button>
      {placedByHand && (
        <Check checked={replace} disabled={off} onChange={setReplace}>
          Move the ones you placed by hand too
        </Check>
      )}
      <Check
        checked={adding}
        disabled={off || !known}
        title={
          known ? undefined : 'The room has nothing to look for yet, so the scan adds what it sees.'
        }
        onChange={setAddNew}
      >
        Add new fixtures it finds
      </Check>
      <Cost>1 Spark and 1 SAM call, refused if today’s limit can’t cover them.</Cost>
      {(lab.memory?.dismissed?.length ?? 0) > 0 && (
        <p className="micro">
          Skipped as not fixtures:{' '}
          {lab.memory!.dismissed!.map((d, i) => (
            <span key={d}>
              {i > 0 && ', '}
              {d}{' '}
              <IconButton
                size="sm"
                disabled={off}
                label={`Let scans find “${d}” again`}
                onClick={() =>
                  void call<DeskMemory>('fixtures/undismiss', { label: d }, (m) => {
                    lab.setMemory(m);
                    lab.setMessage(`Scans will find things named like “${d}” again.`);
                  })
                }
              >
                ×
              </IconButton>
            </span>
          ))}
        </p>
      )}
      {mapped && mapped.length > 0 && (
        <ul className="scan-list">
          {mapped.map((m, i) => (
            <li key={`${m.label}-${i}`}>
              <strong>{m.label}</strong>
              <span className={`tiny scan-${m.match}`}>{MATCH_LABEL[m.match].toUpperCase()}</span>
              <small>{m.note}</small>
            </li>
          ))}
        </ul>
      )}
    </Details>
  );
}
