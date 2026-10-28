import type { CSSProperties } from 'react';
import type { Segmentation } from '@livinglayer/domain';

/** SAM masks with HUD brackets, drawn in the frame's own pixel space. */
export function MaskOverlay({
  segmentation,
  chosenId,
}: {
  segmentation: Segmentation;
  chosenId?: string;
}) {
  return (
    <svg
      className="mask-overlay"
      viewBox={`0 0 ${segmentation.frame.width} ${segmentation.frame.height}`}
      aria-label={`${segmentation.detections.length} segmentation masks`}
    >
      {segmentation.detections.map((d, i) => {
        const { x, y, width: w, height: h } = d.box;
        const t = Math.max(10, Math.min(w, h) * 0.22);
        const chosen = d.objectId === chosenId;
        return (
          <g key={`${d.objectId}-${i}`} className={`detection ${chosen ? 'chosen' : ''}`}>
            <path
              className="mask"
              d={d.mask.svgPath}
              transform={`translate(${x} ${y}) scale(${w / d.mask.width} ${h / d.mask.height})`}
              fillRule="evenodd"
            />
            <polyline points={`${x},${y + t} ${x},${y} ${x + t},${y}`} />
            <polyline points={`${x + w - t},${y} ${x + w},${y} ${x + w},${y + t}`} />
            <polyline points={`${x},${y + h - t} ${x},${y + h} ${x + t},${y + h}`} />
            <polyline points={`${x + w - t},${y + h} ${x + w},${y + h} ${x + w},${y + h - t}`} />
            <rect
              className="scan"
              x={x}
              y={y}
              width={w}
              height={Math.max(2, h * 0.012)}
              style={{ '--travel': `${h}px` } as CSSProperties}
            />
            <text x={x} y={y - 10} fontSize={Math.round(segmentation.frame.width / 60)}>
              {chosen ? '✓ ' : ''}
              {segmentation.concept.toUpperCase()} · #{d.objectId}
              {d.confidence != null ? ` · ${d.confidence.toFixed(2)}` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
