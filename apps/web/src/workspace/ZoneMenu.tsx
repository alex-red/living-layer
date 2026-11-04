import type { DeskMemory } from '@livinglayer/domain';
import { ContextMenu } from './ContextMenu';
import { useDesk, useFeedback, useLabParts, useNavigation } from './LabContext';
import { useCall } from './panel';

/** Where a zone's menu was asked for: which zone, at the pointer in the window. */
export interface ZoneMenuAt {
  id: string;
  at: { x: number; y: number };
}

/**
 * A zone's right-click menu, on the photo, the camera, the Iso view or the
 * outline: open it, or turn it off and on again. An off zone stays where it
 * is drawn but isn't judged and switches nothing.
 */
export function ZoneMenu({ menu, onClose }: { menu: ZoneMenuAt; onClose: () => void }) {
  const lab = useLabParts(useFeedback(), useDesk(), useNavigation());
  const { call, off: waiting } = useCall();
  const rule = lab.memory?.rules?.find((r) => r.id === menu.id);
  if (!rule) return null;
  const off = Boolean(rule.off);
  return (
    <ContextMenu
      at={menu.at}
      label={`${rule.label} actions`}
      items={[
        { label: 'Open', onSelect: () => lab.select({ kind: 'rule', id: rule.id }) },
        {
          label: off ? 'Turn on' : 'Turn off',
          separated: true,
          disabled: waiting,
          title: off
            ? 'Judge it again and run its steps.'
            : 'Keep it, but stop judging it and running its steps.',
          onSelect: () =>
            void call<DeskMemory>('desk/rules/options', { ruleId: rule.id, off: !off }, (m) => {
              lab.setMemory(m, false);
              lab.setMessage(`"${rule.label}" is ${off ? 'on' : 'off'}.`);
            }),
        },
      ]}
      onClose={onClose}
    />
  );
}
