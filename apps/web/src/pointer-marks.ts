/**
 * A soft dot that follows the pointer and a ring on each click, for
 * recordings: a tab's capture leaves the system cursor out. Returns a
 * function that takes them away again.
 *
 * It is also injected as is into pages `bun run record` opens (Playwright
 * sends its source), so it must stay self-contained: no imports, nothing
 * from outside its own body.
 */
export function installPointerMarks(): () => void {
  const root = document.documentElement;
  const style = document.createElement('style');
  style.textContent = `
    .pointer-mark, .pointer-ring { position: fixed; left: 0; top: 0; pointer-events: none; z-index: 2147483647; border-radius: 50%; }
    .pointer-mark { width: 18px; height: 18px; margin: -9px 0 0 -9px; background: rgb(20 20 20 / 35%); border: 2px solid rgb(255 255 255 / 90%); box-shadow: 0 1px 4px rgb(0 0 0 / 35%); transition: scale 80ms ease-out, opacity 200ms; opacity: 0; }
    .pointer-mark.down { scale: 0.75; }
    .pointer-ring { width: 36px; height: 36px; margin: -18px 0 0 -18px; border: 2px solid rgb(255 255 255 / 95%); box-shadow: 0 0 0 1px rgb(0 0 0 / 25%); animation: pointer-ring 450ms ease-out forwards; }
    @keyframes pointer-ring { from { scale: 0.3; opacity: 1; } to { scale: 1.4; opacity: 0; } }`;
  const dot = document.createElement('div');
  dot.className = 'pointer-mark';
  dot.setAttribute('aria-hidden', 'true');
  root.append(style, dot);
  const place = (el: HTMLElement, e: PointerEvent) => {
    el.style.translate = `${e.clientX}px ${e.clientY}px`;
  };
  const move = (e: PointerEvent) => {
    place(dot, e);
    dot.style.opacity = '1';
  };
  const down = (e: PointerEvent) => {
    dot.classList.add('down');
    const ring = document.createElement('div');
    ring.className = 'pointer-ring';
    ring.setAttribute('aria-hidden', 'true');
    place(ring, e);
    root.append(ring);
    ring.addEventListener('animationend', () => ring.remove());
  };
  const up = () => dot.classList.remove('down');
  const leave = () => {
    dot.style.opacity = '0';
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerdown', down, true);
  addEventListener('pointerup', up, true);
  root.addEventListener('pointerleave', leave);
  return () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerdown', down, true);
    removeEventListener('pointerup', up, true);
    root.removeEventListener('pointerleave', leave);
    style.remove();
    dot.remove();
  };
}
