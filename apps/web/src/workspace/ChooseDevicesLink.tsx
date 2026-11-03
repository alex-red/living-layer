import { Button } from '../ui/controls';
import { useLabParts, useNavigation } from './LabContext';

/** Where a panel with nothing to switch sends someone: the Home Assistant panel. */
export function ChooseDevicesLink({ why }: { why: string }) {
  const lab = useLabParts(useNavigation());
  return (
    <p className="micro">
      {why}{' '}
      <Button variant="text" onClick={() => lab.select({ kind: 'devices' })}>
        Set up Home Assistant →
      </Button>
    </p>
  );
}
