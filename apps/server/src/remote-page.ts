/**
 * The page a phone opens from the pairing QR code. It is self-contained (the
 * phone server serves nothing else) and finds its pairing from its own URL.
 * It shares the back camera, keeps the screen awake, and answers the lab's
 * offers until the pairing ends.
 */
export function phonePage(nonce: string, paired: boolean) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Living Layer camera</title>
<style nonce="${nonce}">
  :root { --void: #0a0c12; --surface: #181c28; --line: rgb(170 185 255 / 18%); --text: #ece9f2;
    --text-2: #a9aec2; --seen: #6fd3e0; --ok: #86d9aa; --blocked: #f27c83;
    --ui: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--void); color: var(--text); font: 15px/1.45 var(--ui); }
  body { display: flex; flex-direction: column; padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom); }
  header { display: flex; align-items: center; gap: 10px; padding: 14px 0; }
  header b { font-weight: 600; letter-spacing: 0.01em; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-2); flex: none; }
  .live .dot { background: var(--ok); box-shadow: 0 0 10px var(--ok); }
  .bad .dot { background: var(--blocked); }
  .frame { position: relative; flex: 1; min-height: 0; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; background: #000; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .front video { transform: scaleX(-1); }
  #status { margin: 12px 0 4px; color: var(--text-2); min-height: 2.9em; }
  .live #status { color: var(--text); }
  .row { display: flex; gap: 8px; padding: 8px 0 16px; }
  button { flex: 1; font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--line);
    border-radius: 2px; padding: 12px; }
  button:disabled { opacity: 0.5; }
  button[hidden] { display: none; }
</style>
</head>
<body>
<header><span class="dot"></span><b>Living Layer camera</b></header>
<div class="frame"><video id="video" autoplay playsinline muted></video></div>
<p id="status" role="status">${paired ? 'Opening the camera…' : 'This pairing has ended. Scan the new QR code in Living Layer.'}</p>
<div class="row">
  <button id="start" hidden>Share camera</button>
  <button id="flip" disabled>Switch camera</button>
</div>
<script nonce="${nonce}">
(() => {
  const base = location.pathname.replace(/\\/$/, '');
  const $ = (id) => document.getElementById(id);
  const video = $('video'), status = $('status'), start = $('start'), flip = $('flip');
  let stream = null, pc = null, listening = false, facing = 'environment', ended = ${paired ? 'false' : 'true'}, wake = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const show = (text, tone = '') => {
    status.textContent = text;
    document.body.className = tone + (facing === 'user' ? ' front' : '');
  };
  const idle = () => show(pc ? 'Streaming to Living Layer.' : 'Paired. Start the camera in Living Layer, with this phone as its source.');

  async function keepAwake() {
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* Not offered here; the phone may dim. */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !ended) void keepAwake();
  });

  async function openCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => { if (!ended) show('The camera stopped. Tap Share camera to start it again.', 'bad'); start.hidden = false; });
    await pc?.getSenders()[0]?.replaceTrack(track);
  }

  function hangUp() {
    pc?.close();
    pc = null;
  }

  async function answer(offer) {
    hangUp();
    const peer = (pc = new RTCPeerConnection());
    peer.addEventListener('connectionstatechange', () => {
      if (pc !== peer) return;
      if (peer.connectionState === 'connected') show('Streaming to Living Layer.', 'live');
      if (peer.connectionState === 'failed') { hangUp(); show('The connection to Living Layer dropped. Start the camera there again.', 'bad'); }
    });
    await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    // Takes the receive-only transceiver the lab offered, so the answer is send-only.
    peer.addTrack(stream.getVideoTracks()[0], stream);
    await peer.setLocalDescription(await peer.createAnswer());
    await new Promise((resolve) => {
      if (peer.iceGatheringState === 'complete') return resolve();
      peer.addEventListener('icegatheringstatechange', () => peer.iceGatheringState === 'complete' && resolve());
      setTimeout(resolve, 1500);
    });
    show('Connecting to Living Layer…');
    const sent = await fetch(base + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: offer.id, sdp: peer.localDescription.sdp }),
    });
    if (!sent.ok) { if (pc === peer) hangUp(); idle(); }
  }

  async function listen() {
    while (!ended) {
      let response;
      try {
        response = await fetch(base + '/next', { cache: 'no-store' });
      } catch {
        show('Lost Living Layer. Is it still running on the same network? Retrying…', 'bad');
        await sleep(2000);
        continue;
      }
      if (response.status === 404) {
        ended = true;
        hangUp();
        stream?.getTracks().forEach((t) => t.stop());
        wake?.release().catch(() => {});
        flip.disabled = true;
        show('This pairing has ended. Scan the new QR code in Living Layer.', 'bad');
        return;
      }
      if (response.status === 204) { if (!pc) idle(); continue; }
      if (!response.ok) { await sleep(2000); continue; }
      const event = await response.json();
      if (event.type === 'hangup') { hangUp(); idle(); }
      if (event.type === 'offer')
        answer(event).catch(() => { hangUp(); show('Could not connect to Living Layer. Start the camera there again.', 'bad'); });
    }
  }

  async function begin() {
    start.hidden = true;
    try {
      await openCamera();
    } catch {
      start.hidden = false;
      show('The camera is unavailable. Allow camera access for this page, then tap Share camera.', 'bad');
      return;
    }
    flip.disabled = false;
    void keepAwake();
    idle();
    if (!listening) {
      listening = true;
      void listen();
    }
  }

  start.addEventListener('click', () => void begin());
  flip.addEventListener('click', async () => {
    flip.disabled = true;
    facing = facing === 'environment' ? 'user' : 'environment';
    try { await openCamera(); } catch { show('That camera is unavailable.', 'bad'); }
    document.body.classList.toggle('front', facing === 'user');
    flip.disabled = false;
  });
  if (!ended) {
    if (!navigator.mediaDevices?.getUserMedia) show('This browser cannot share its camera from this page. Open the link in Safari or Chrome.', 'bad');
    else void begin();
  }
})();
</script>
</body>
</html>`;
}
