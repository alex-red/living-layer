/**
 * Moves one frame from the camera playground to the desk lab. The image stays
 * in this browser tab's session storage; nothing is uploaded until the lab
 * runs a live probe on it.
 */
const KEY = 'livinglayer:handoff';

export function sendToLab(imageDataUrl: string): boolean {
  try {
    sessionStorage.setItem(KEY, imageDataUrl);
  } catch {
    return false;
  }
  window.location.assign('/');
  return true;
}

/** Reads the waiting frame once, then forgets it. */
export function takeHandoff(): string | null {
  try {
    const url = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return url?.startsWith('data:image/') ? url : null;
  } catch {
    return null;
  }
}
