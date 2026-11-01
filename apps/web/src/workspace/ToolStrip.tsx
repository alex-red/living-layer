/**
 * What a drag on the canvas does: select and move fixtures, stretch one's
 * base, pan, or select part of the picture for the AI brush.
 */
export type Tool = 'select' | 'scale' | 'hand' | 'brush';

const TOOLS: { id: Tool; label: string; key: string; hint: string; icon: string }[] = [
  {
    id: 'select',
    label: 'Select',
    key: 'V',
    hint: 'Click a fixture to select it; drag it to move it',
    icon: 'M5 3l13 8-6 1.5L9 19z',
  },
  {
    id: 'scale',
    label: 'Scale',
    key: 'S',
    hint: 'Drag the handles on the selected fixture’s base to stretch it',
    icon: 'M4 9V4h5M20 15v5h-5M4 4l7 7M20 20l-7-7',
  },
  {
    id: 'brush',
    label: 'AI brush',
    key: 'B',
    hint: 'Drag a box, or click points around a thing, then say what to do with it',
    icon: 'M14 4l6 6-9 9H5v-6zM12 6l6 6M4 21h7',
  },
  {
    id: 'hand',
    label: 'Pan',
    key: 'H',
    hint: 'Drag anywhere to pan the view',
    icon: 'M8 13V6a1.5 1.5 0 013 0v5m0-6a1.5 1.5 0 013 0v6m0-5a1.5 1.5 0 013 0v7c0 4-2.5 6-6 6s-5-2-7-5l-1.5-2.5a1.5 1.5 0 012.5-1.6L8 15',
  },
];

/**
 * A thin row of canvas tools over the stage. A tool that can't act on what
 * is shown is disabled, with the reason in its hint, and `note` says what
 * the chosen tool needs next.
 */
export function ToolStrip({
  tool,
  onTool,
  disabled = {},
  note,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  /** Tools that can't act here, and why. */
  disabled?: Partial<Record<Tool, string>>;
  note?: string;
}) {
  return (
    <div className="tool-strip" role="toolbar" aria-label="Canvas tools">
      {TOOLS.map((t) => {
        const why = disabled[t.id];
        return (
          <button
            key={t.id}
            aria-pressed={tool === t.id}
            disabled={Boolean(why)}
            title={`${t.label} (${t.key}) · ${why ?? t.hint}`}
            onClick={() => onTool(t.id)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={t.icon} />
            </svg>
            {t.label}
            <kbd>{t.key}</kbd>
          </button>
        );
      })}
      {note && <span className="tool-note">{note}</span>}
    </div>
  );
}
