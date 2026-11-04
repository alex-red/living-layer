/**
 * The pure parts of `bun run shot`: a take's beats turned into a zoom curve,
 * speed ramps, captions and titles (ASS for libass), and the joins of a film.
 * Times in a beat are the take's (seconds since recording began); `retime`
 * maps them to the cut once the fast stretches are sped up.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}

export type Beat =
  /** Line `i` of the shot starts; `dur` is its voice's length (or the estimate while there is none). */
  | { kind: 'line'; t: number; i: number; dur: number }
  /** The camera eases to show `box` (page pixels), or the whole page when null. */
  | { kind: 'focus'; t: number; box: Box | null }
  | { kind: 'lower'; t: number; dur: number; title: string; sub: string }
  | { kind: 'title'; t: number; dur: number; text: string; sub: string }
  /**
   * A full-frame card on black: a line of text (typed on a letter at a time
   * when `typed`), or a slate standing in for a clip not filmed yet.
   */
  | {
      kind: 'card';
      t: number;
      dur: number;
      text: string;
      sub: string;
      look: 'plain' | 'typed' | 'slate';
    }
  /** From `t` until the next `speed` beat, the cut plays `speed` times faster. */
  | { kind: 'speed'; t: number; speed: number };

/** What a take leaves for composing it again without re-recording. */
export interface Take {
  shot: string;
  view: Size;
  scale: number;
  fps: number;
  length: number;
  beats: Beat[];
}

/** Seconds to say `text` at an unhurried 2.5 words a second, with a breath: the stand-in for a voice. */
export function estimateSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 2.5 + 0.4) * 100) / 100;
}

// ---- Camera ----

export interface CameraKey {
  t: number;
  zoom: number;
  /** Centre, as shares of the page. */
  cx: number;
  cy: number;
}

/** Seconds a zoom takes to ease to its next target. */
export const ZOOM_SECONDS = 0.9;

/**
 * The camera's targets from the focus beats: zoomed so the box fills about
 * 90% of the frame (never below 1, never past `maxZoom`), centred on it but
 * kept inside the page.
 */
export function cameraKeys(beats: Beat[], view: Size, maxZoom = 2.4): CameraKey[] {
  const keys: CameraKey[] = [{ t: 0, zoom: 1, cx: 0.5, cy: 0.5 }];
  for (const b of beats) {
    if (b.kind !== 'focus') continue;
    if (!b.box) {
      keys.push({ t: b.t, zoom: 1, cx: 0.5, cy: 0.5 });
      continue;
    }
    const zoom = Math.min(
      maxZoom,
      Math.max(1, 0.9 * Math.min(view.width / b.box.width, view.height / b.box.height)),
    );
    const half = 0.5 / zoom;
    const clamp = (v: number) => Math.min(1 - half, Math.max(half, v));
    keys.push({
      t: b.t,
      zoom,
      cx: clamp((b.box.x + b.box.width / 2) / view.width),
      cy: clamp((b.box.y + b.box.height / 2) / view.height),
    });
  }
  return keys;
}

const smooth = (u: number) => u * u * (3 - 2 * u);

/** The camera at take time `t`: each key eased in (smoothstep) from the one before over ZOOM_SECONDS. */
export function cameraAt(keys: CameraKey[], t: number): Omit<CameraKey, 't'> {
  const at = { zoom: keys[0]!.zoom, cx: keys[0]!.cx, cy: keys[0]!.cy };
  for (let i = 1; i < keys.length; i++) {
    const e = smooth(Math.min(1, Math.max(0, (t - keys[i]!.t) / ZOOM_SECONDS)));
    for (const k of ['zoom', 'cx', 'cy'] as const) at[k] += (keys[i]![k] - keys[i - 1]![k]) * e;
  }
  return { ...at, zoom: Math.max(1, at.zoom) };
}

/**
 * The same curve as ffmpeg filters: `perspective` samples the view's corners
 * from the take at fractional pixels (time from the frame number), then one
 * scale to `out`. zoompan rounds its window to whole pixels, so a slow zoom
 * judders; a per-frame `scale` then `crop` keeps the first frame's size. No
 * st()/ld(): their ';' would end the filter chain. The zoom is clamped at 1.
 */
export function zoomFilter(keys: CameraKey[], out: Size, fps: number): string {
  const curve = (k: 'zoom' | 'cx' | 'cy') =>
    `${keys[0]![k]}` +
    keys
      .slice(1)
      .map((key, i) => {
        const d = key[k] - keys[i]![k];
        if (Math.abs(d) < 1e-4) return '';
        const u = `clip((in/${fps}-${key.t.toFixed(3)})/${ZOOM_SECONDS},0,1)`;
        return `+(${d.toFixed(5)})*${u}*${u}*(3-2*${u})`;
      })
      .join('');
  const z = `max(1,${curve('zoom')})`;
  // The centre, kept so the view never leaves the take while the zoom and centre ease together.
  const cx = `clip(${curve('cx')},0.5/${z},1-0.5/${z})`;
  const cy = `clip(${curve('cy')},0.5/${z},1-0.5/${z})`;
  const left = `W*(${cx}-0.5/${z})`;
  const right = `W*(${cx}+0.5/${z})`;
  const top = `H*(${cy}-0.5/${z})`;
  const bottom = `H*(${cy}+0.5/${z})`;
  return (
    `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}'` +
    `:x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}'` +
    `:interpolation=cubic:sense=source:eval=frame,` +
    `scale=${out.width}:${out.height}:flags=lanczos,fps=${fps}`
  );
}

// ---- Speed ----

export interface Ramp {
  from: number;
  to: number;
  speed: number;
}

/** The fast stretches of a take, from its speed beats; an open one runs to `length`. */
export function rampsOf(beats: Beat[], length: number): Ramp[] {
  const ramps: Ramp[] = [];
  let open: { t: number; speed: number } | null = null;
  for (const b of beats) {
    if (b.kind !== 'speed') continue;
    if (open && open.speed !== 1 && b.t > open.t)
      ramps.push({ from: open.t, to: b.t, speed: open.speed });
    open = { t: b.t, speed: b.speed };
  }
  if (open && open.speed !== 1 && length > open.t)
    ramps.push({ from: open.t, to: length, speed: open.speed });
  return ramps;
}

/** Take time → cut time, with each ramp's stretch played `speed` times faster. */
export function retime(t: number, ramps: Ramp[]): number {
  let out = t;
  for (const r of ramps)
    out -= Math.min(Math.max(t - r.from, 0), r.to - r.from) * (1 - 1 / r.speed);
  return out;
}

/** The ramps as one `setpts` (then a steady frame rate), or nothing when there are none. */
export function rampFilter(ramps: Ramp[], fps: number): string | null {
  if (!ramps.length) return null;
  const cut = ramps
    .map(
      (r) =>
        `-clip(T-${r.from.toFixed(3)},0,${(r.to - r.from).toFixed(3)})*${(1 - 1 / r.speed).toFixed(5)}`,
    )
    .join('');
  return `setpts='(T${cut})/TB',fps=${fps}`;
}

// ---- Captions, lower thirds, titles (ASS) ----

/** ASS colour from a CSS hex: &HBBGGRR. */
const assColour = (hex: string) => {
  const h = hex.replace('#', '');
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};
/** The app's tokens (`apps/web/src/tokens.css`). */
const TONE = {
  seen: '#6fd3e0',
  text: '#ece9f2',
  text2: '#a9aec2',
  void: '#0a0c12',
  card: '#11141d',
};

/** h:mm:ss.cc */
export function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Text safe in an ASS event: no override blocks, no hard breaks but ours. */
const assText = (s: string) => s.replace(/[{}]/g, '').replace(/\\/g, '').replace(/\n/g, ' ');

/**
 * A caption as ASS rows (`\\N` between them): one row when it fits in `max`
 * characters, else two broken at the word end nearest the middle, so neither
 * row is an orphan; longer still, greedy rows of `max`.
 */
export function captionRows(text: string, max = 46): string {
  const words = assText(text).split(/\s+/).filter(Boolean);
  const line = words.join(' ');
  if (line.length <= max) return line;
  if (line.length <= 2 * max) {
    let best = 1;
    for (let i = 1; i < words.length; i++) {
      const left = words.slice(0, i).join(' ').length;
      const bestLeft = words.slice(0, best).join(' ').length;
      if (Math.abs(left - line.length / 2) < Math.abs(bestLeft - line.length / 2)) best = i;
    }
    return `${words.slice(0, best).join(' ')}\\N${words.slice(best).join(' ')}`;
  }
  const rows: string[] = [];
  let row = '';
  for (const word of words) {
    if (row && row.length + 1 + word.length > max) {
      rows.push(row);
      row = word;
    } else row = row ? `${row} ${word}` : word;
  }
  return [...rows, row].join('\\N');
}

/**
 * A line too long for two caption rows, split at sentence (else clause) ends
 * into chunks of at most `max` characters, each shown for its share of `dur`
 * by length. Offsets are seconds from the line's start.
 */
export function captionChunks(
  text: string,
  dur: number,
  max = 88,
): { text: string; from: number; to: number }[] {
  const clean = assText(text).replace(/\s+/g, ' ').trim();
  const pieces = clean.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((p) => p.trim()) ?? [clean];
  const chunks: string[] = [];
  const add = (piece: string) => {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + piece.length <= max)
      chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  };
  for (const piece of pieces) {
    if (piece.length <= max) add(piece);
    else for (const clause of piece.split(/(?<=[,;:])\s+/)) add(clause);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  let at = 0;
  return chunks.map((c) => {
    const from = at;
    at += (dur * c.length) / total;
    return { text: c, from, to: at };
  });
}

/**
 * The shot's overlays as an ASS script over `out`: captions from its lines
 * (bottom centre), lower thirds (a card bottom left with a cyan rule) and
 * title cards (centred over a dimmed frame), all at cut time.
 */
export function overlays(beats: Beat[], lines: string[], ramps: Ramp[], out: Size): string {
  const W = out.width;
  const H = out.height;
  const k = H / 1080;
  const px = (n: number) => Math.round(n * k);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Avenir Next,${px(44)},${assColour(TONE.text)},${assColour(TONE.text)},&H22${assColour(TONE.void).slice(2)},&H22${assColour(TONE.void).slice(2)},1,0,0,0,100,100,0,0,3,${px(14)},0,2,${px(200)},${px(200)},${px(64)},1
Style: Lower,Menlo,${px(30)},${assColour(TONE.seen)},${assColour(TONE.seen)},&H00000000,&H00000000,1,0,0,0,100,100,${px(3)},0,1,0,0,7,0,0,0,1
Style: LowerSub,Avenir Next,${px(28)},${assColour(TONE.text2)},${assColour(TONE.text2)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Shape,Avenir Next,10,${assColour(TONE.card)},${assColour(TONE.card)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Title,Avenir Next,${px(96)},${assColour(TONE.text)},${assColour(TONE.text)},&H00000000,&H00000000,1,0,0,0,100,100,-1,0,1,0,0,5,0,0,0,1
Style: Card,Avenir Next,${px(58)},${assColour(TONE.text)},${assColour(TONE.text)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,${px(160)},${px(160)},0,1
Style: Slate,Menlo,${px(34)},${assColour(TONE.text2)},${assColour(TONE.text2)},&H00000000,&H00000000,0,0,0,0,100,100,${px(2)},0,1,0,0,5,${px(160)},${px(160)},0,1
Style: TitleSub,Menlo,${px(26)},${assColour(TONE.seen)},${assColour(TONE.seen)},&H00000000,&H00000000,0,0,0,0,100,100,${px(4)},0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev: string[] = [];
  const at = (t: number) => retime(t, ramps);
  const rect = (w: number, h: number) => `{\\p1}m 0 0 l ${w} 0 ${w} ${h} 0 ${h}{\\p0}`;
  const dialogue = (layer: number, from: number, to: number, style: string, text: string) =>
    ev.push(`Dialogue: ${layer},${assTime(from)},${assTime(to)},${style},,0,0,0,,${text}`);
  for (const b of beats) {
    if (b.kind === 'line') {
      const t = at(b.t);
      const chunks = captionChunks(lines[b.i] ?? '', b.dur);
      chunks.forEach((c, n) => {
        const last = n === chunks.length - 1;
        dialogue(
          3,
          t + c.from,
          t + c.to + (last ? 0.25 : 0),
          'Caption',
          `{\\fad(${n ? 0 : 120},${last ? 120 : 0})}${captionRows(c.text)}`,
        );
      });
    }
    if (b.kind === 'lower') {
      const t = at(b.t);
      const x = px(60);
      const y = H - px(216);
      const width = px(Math.max(420, 40 + 15.5 * Math.max(b.title.length * 1.2, b.sub.length)));
      const fade = '\\fad(180,220)';
      dialogue(0, t, t + b.dur, 'Shape', `{${fade}\\pos(${x},${y})}${rect(width, px(112))}`);
      dialogue(
        1,
        t,
        t + b.dur,
        'Shape',
        `{${fade}\\pos(${x},${y})\\1c${assColour(TONE.seen)}}${rect(px(6), px(112))}`,
      );
      dialogue(
        2,
        t + 0.12,
        t + b.dur,
        'Lower',
        `{${fade}\\move(${x + px(10)},${y + px(16)},${x + px(30)},${y + px(16)},0,260)}${assText(b.title)}`,
      );
      dialogue(
        2,
        t + 0.24,
        t + b.dur,
        'LowerSub',
        `{${fade}\\move(${x + px(10)},${y + px(58)},${x + px(30)},${y + px(58)},0,300)}${assText(b.sub)}`,
      );
    }
    if (b.kind === 'title') {
      const t = at(b.t);
      const fade = '\\fad(250,400)';
      dialogue(
        0,
        t,
        t + b.dur,
        'Shape',
        `{${fade}\\pos(0,0)\\1c${assColour(TONE.void)}\\1a&H38&}${rect(W, H)}`,
      );
      dialogue(
        1,
        t,
        t + b.dur,
        'Title',
        `{${fade}\\pos(${W / 2},${H / 2 - px(20)})\\t(0,${Math.round(b.dur * 1000)},\\fscx104\\fscy104)}${assText(b.text)}`,
      );
      if (b.sub)
        dialogue(
          1,
          t + 0.25,
          t + b.dur,
          'TitleSub',
          `{${fade}\\pos(${W / 2},${H / 2 + px(62)})}${assText(b.sub.toUpperCase())}`,
        );
    }
    if (b.kind === 'card') {
      const t = at(b.t);
      const end = t + b.dur;
      dialogue(0, t, end, 'Shape', `{\\pos(0,0)\\1c${assColour(TONE.void)}}${rect(W, H)}`);
      const text = assText(b.text);
      // A short plain card is a title: large and bold, its line under it in the HUD's type.
      const title = b.look === 'plain' && b.text.length <= 28;
      const centre = `\\pos(${W / 2},${H / 2 - (b.sub ? px(title ? 20 : 24) : 0)})`;
      if (b.look === 'typed') {
        // Each prefix shown with the rest drawn clear, so the line stays where it will end.
        const steps = typedSteps(text);
        steps.forEach((step, k) =>
          dialogue(
            1,
            t + step.at,
            k + 1 < steps.length ? t + steps[k + 1]!.at : end,
            'Card',
            `{${centre}}${text.slice(0, step.chars)}{\\alpha&HFF&}${text.slice(step.chars)}`,
          ),
        );
      } else
        dialogue(
          1,
          t,
          end,
          b.look === 'slate' ? 'Slate' : title ? 'Title' : 'Card',
          `{${centre}${b.look === 'plain' ? '\\fad(200,200)' : ''}}${text}`,
        );
      if (b.sub)
        dialogue(
          1,
          t + (title ? 0.25 : 0),
          end,
          title ? 'TitleSub' : 'LowerSub',
          `{\\an5\\pos(${W / 2},${H / 2 + px(title ? 62 : 44)})${title ? '\\fad(250,200)' : ''}}${assText(title ? b.sub.toUpperCase() : b.sub)}`,
        );
    }
  }
  return head + ev.join('\n') + '\n';
}

/** Letters a second for a typed card. */
export const TYPED_CPS = 22;

/**
 * When each prefix of a typed card shows: a letter every 1/TYPED_CPS s, a
 * little longer after a comma or a full stop, as a hand would type it. Each
 * step's `at` is seconds from the card's start; the last shows the whole line.
 */
export function typedSteps(text: string): { at: number; chars: number }[] {
  const steps: { at: number; chars: number }[] = [];
  let at = 0.3;
  for (let i = 1; i <= text.length; i++) {
    steps.push({ at, chars: i });
    const c = text[i - 1]!;
    at += 1 / TYPED_CPS + (c === ',' ? 0.18 : /[.?!]/.test(c) ? 0.3 : 0);
  }
  return steps;
}

// ---- The film ----

/** Where each join starts in the film: shot i+1 fades in over the last `fade` seconds of what came before. */
export function joinOffsets(lengths: number[], fade: number): number[] {
  const offsets: number[] = [];
  let end = 0;
  lengths.forEach((len, i) => {
    if (i > 0) offsets.push(end - fade);
    end = i === 0 ? len : end - fade + len;
  });
  return offsets;
}

/** One filter_complex joining n shots (inputs 0…n-1, each with video and audio) with cross-fades. */
export function joinFilter(lengths: number[], fade: number): string {
  if (lengths.length === 1) return '[0:v]null[v];[0:a]anull[a]';
  const offsets = joinOffsets(lengths, fade);
  const parts: string[] = [];
  let v = '[0:v]';
  let a = '[0:a]';
  offsets.forEach((offset, i) => {
    const last = i === offsets.length - 1;
    const vo = last ? '[v]' : `[v${i + 1}]`;
    const ao = last ? '[a]' : `[a${i + 1}]`;
    parts.push(
      `${v}[${i + 1}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${vo}`,
    );
    parts.push(`${a}[${i + 1}:a]acrossfade=d=${fade}${ao}`);
    v = vo;
    a = ao;
  });
  return parts.join(';');
}
