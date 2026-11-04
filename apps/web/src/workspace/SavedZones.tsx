import { useCallback, useState, type CSSProperties } from 'react';
import { MAIN_RULE, actionsColor, ruleActions } from '@livinglayer/domain';
import { useCamera, useDesk, useLabParts, useNavigation, useView } from './LabContext';
import { ruleRects, useHoveredZone } from './zoneHover';
import { ZoneMenu, type ZoneMenuAt } from './ZoneMenu';
import './saved-zones.css';

/**
 * Every zone but the main one (which `ZoneLayer` draws), over the photo or
 * the camera's frames, each named and marked when something is in it: a
 * motion zone while it sees motion, any other while it is occupied. A zone
 * whose steps turn a light a colour is drawn in it. The one being changed
 * shows as its draft only. A zone is named while the pointer is over it or
 * it is selected. A right-click on any zone, the main one too, opens its
 * menu; one turned off is drawn faint.
 */
export function SavedZones() {
  const lab = useLabParts(useView(), useCamera(), useDesk(), useNavigation());
  const { camera, cameraSize, memory, showZones, ruleDraft, dimensions, selection } = lab;
  const zones = (memory?.rules ?? []).filter((r) => r.id !== MAIN_RULE && r.id !== ruleDraft?.id);
  const [menu, setMenu] = useState<ZoneMenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Not while a zone is drawn or a surface pinned: a right-click there is part of that.
  const menus = !lab.drawing && !ruleDraft && !lab.pinning;
  // On the camera, fitted to the picture like the video; on a photo, the stage is the picture.
  const size = camera ? cameraSize : dimensions;
  // The main zone is hit-tested too, so only the innermost of two that overlap is named.
  const { ref, hovered } = useHoveredZone(
    ruleRects(memory),
    camera ? cameraSize : null,
    menus ? (id, at) => setMenu({ id, at }) : null,
  );
  if (!showZones || !memory?.rules?.length || !size) return null;
  const font = Math.max(11, Math.round(size.width / 80));
  return (
    <>
      <svg
        ref={ref}
        className="saved-zones"
        viewBox={`0 0 ${size.width} ${size.height}`}
        {...(camera ? {} : { preserveAspectRatio: 'none' })}
        aria-label="Saved zones"
      >
        {zones.map((r) => {
          const { x, y, width, height } = r.zone.rect;
          const on = !r.off && r.placement === 'inside';
          const state = r.off
            ? 'OFF'
            : r.motion
              ? on
                ? 'MOTION'
                : 'STILL'
              : on
                ? 'OCCUPIED'
                : 'EMPTY';
          const rgb = actionsColor(ruleActions(r));
          return (
            <g
              key={r.id}
              className={`saved-zone ${r.motion ? 'motion' : ''} ${on ? 'on' : ''} ${r.off ? 'off' : ''}`}
              style={rgb ? ({ '--zone': `rgb(${rgb.join(' ')})` } as CSSProperties) : undefined}
            >
              <rect
                x={x * size.width}
                y={y * size.height}
                width={width * size.width}
                height={height * size.height}
              />
              {(hovered === r.id || (selection?.kind === 'rule' && selection.id === r.id)) && (
                <text x={x * size.width} y={y * size.height - 5} fontSize={font}>
                  {`${r.label.toUpperCase()} · ${state}`}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {menu && <ZoneMenu menu={menu} onClose={closeMenu} />}
    </>
  );
}
