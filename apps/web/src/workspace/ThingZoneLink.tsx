import { Button } from '../ui/controls';
import { useDesk, useLabParts, useNavigation } from './LabContext';
import { useCall } from './panel';

/**
 * Make a thing a zone (a coaster, a tray), or open the zone it already is:
 * anything stood on it, wherever it goes.
 */
export function ThingZoneLink({ id }: { id: string }) {
  const lab = useLabParts(useDesk(), useNavigation());
  const { off } = useCall();
  const zone = lab.memory?.rules?.find((r) => r.anchor?.thingId === id);
  return zone ? (
    <Button variant="text" onClick={() => lab.select({ kind: 'rule', id: zone.id })}>
      Its zone, “{zone.label}” →
    </Button>
  ) : (
    <Button variant="text" disabled={off} onClick={() => lab.startThingZone(id)}>
      Make it a zone →
    </Button>
  );
}
