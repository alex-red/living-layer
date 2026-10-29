import { useEffect, useState } from 'react';
import { api } from './api';
import type { NetworkStream } from './streams';
import './phone-pairing.css';

interface Pairing {
  url: string;
  /** The QR code for `url`, as SVG markup from the server. */
  qr: string;
  phone: 'waiting' | 'ready';
  stream: NetworkStream | null;
}

/** How often the panel asks whether the phone has opened the page. */
const POLL_MS = 1500;

/**
 * Pairs a phone as a camera: shows a QR code for the phone page and waits for
 * the phone to share its camera. A pairing already open is reused, so closing
 * and reopening the panel keeps the phone connected.
 */
export function PhonePairing({ onUse }: { onUse: (stream: NetworkStream) => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function pair() {
    setBusy(true);
    setError('');
    try {
      setPairing((await api<{ pairing: Pairing | null }>('remote/pair', {})).pairing);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start pairing.');
    } finally {
      setBusy(false);
    }
  }

  async function unpair() {
    setBusy(true);
    await fetch('/api/remote', { method: 'DELETE' }).catch(() => null);
    setPairing(null);
    setBusy(false);
  }

  useEffect(() => {
    let live = true;
    void api<{ pairing: Pairing | null }>('remote')
      .then((r) => {
        if (!live) return;
        if (r.pairing) setPairing(r.pairing);
        else void pair();
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not start pairing.'));
    return () => {
      live = false;
    };
  }, []);

  const waiting = pairing?.phone === 'waiting';
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => {
      void api<{ pairing: Pairing | null }>('remote')
        .then((r) => setPairing(r.pairing))
        .catch(() => null);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [Boolean(pairing)]);

  return (
    <div className="phone-pairing">
      <p className="phone-pairing-title">Use a phone as the camera</p>
      {error && <p className="phone-pairing-error">{error}</p>}
      {!pairing && !error && <p className="phone-pairing-note">Making a pairing code…</p>}
      {!pairing && error && (
        <button disabled={busy} onClick={() => void pair()}>
          Try again
        </button>
      )}
      {pairing && waiting && (
        <>
          <img
            className="phone-pairing-qr"
            alt={`QR code for ${pairing.url}`}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qr)}`}
          />
          <ol className="phone-pairing-steps">
            <li>Scan the code with the phone's camera. It must be on the same Wi-Fi.</li>
            <li>
              The phone warns that the connection isn't private: the lab signs its own certificate.
              Choose to continue to the page.
            </li>
            <li>Allow camera access. This panel moves on once the phone is sharing.</li>
          </ol>
          <p className="phone-pairing-url">{pairing.url}</p>
        </>
      )}
      {pairing && !waiting && (
        <>
          <p className="phone-pairing-ready">
            <span className="phone-pairing-dot" /> {pairing.stream?.name ?? 'Phone'} is sharing
          </p>
          <button
            className="primary"
            disabled={!pairing.stream}
            onClick={() => pairing.stream && onUse(pairing.stream)}
          >
            Use the phone camera
          </button>
        </>
      )}
      {pairing && (
        <div className="phone-pairing-actions">
          <button disabled={busy} onClick={() => void pair()}>
            New code
          </button>
          <button disabled={busy} onClick={() => void unpair()}>
            Unpair
          </button>
        </div>
      )}
    </div>
  );
}
