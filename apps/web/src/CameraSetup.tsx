import { useEffect, useState } from 'react';
import { savedStreamId, type CameraScene, type CameraView } from '@livinglayer/domain';
import { api } from './api';
import { Button, Field, Select } from './ui/controls';
import './camera-setup.css';

export interface RoomOption {
  value: Exclude<CameraScene, null>;
  label: string;
}

interface Draft {
  id?: string;
  name: string;
  url: string;
  /** Shown without credentials: saved, it borrows the stream URL's. */
  substream: string;
  scene: CameraScene;
}
const EMPTY: Draft = { name: '', url: '', substream: '', scene: null };
/** A URL with its user and password left out. */
function withoutCredentials(value: string | null) {
  const url = value ? URL.parse(value) : null;
  if (!url) return '';
  url.username = '';
  url.password = '';
  return url.href;
}

/**
 * Cameras added by their stream URL (RTSP, RTSPS or an HTTP stream), each
 * optionally assigned to a room. The server keeps the URL and reads the
 * stream; the page only ever sees it with the password hidden, so a change
 * that leaves the URL empty keeps the saved one.
 */
export function CameraSetup({
  rooms,
  onChange,
  onUse,
}: {
  rooms: RoomOption[];
  /** The list changed: the lab should list its streams again. */
  onChange: () => void;
  /** Use this camera, by its stream id. */
  onUse: (streamId: string) => void;
}) {
  const [cameras, setCameras] = useState<CameraView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The camera whose Remove was pressed once, waiting for the second press. */
  const [removing, setRemoving] = useState<string | null>(null);
  /** The camera whose still is shown, and a counter so a second check fetches a new one. */
  const [preview, setPreview] = useState<{ id: string; n: number; failed?: boolean } | null>(null);

  useEffect(() => {
    void api('cameras')
      .then((r) => setCameras(r.cameras))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not list cameras.'));
  }, []);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const r = await api('cameras/save', {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
        // Empty clears a saved one; a new camera without one sends nothing.
        ...(draft.id || draft.substream.trim() ? { substream: draft.substream.trim() } : {}),
        scene: draft.scene,
      });
      setCameras(r.cameras);
      setDraft(null);
      setPreview({ id: r.camera.id, n: Date.now() });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the camera.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(camera: CameraView) {
    setRemoving(null);
    setBusy(true);
    setError('');
    try {
      setCameras((await api('cameras/delete', { id: camera.id })).cameras);
      if (preview?.id === camera.id) setPreview(null);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the camera.');
    } finally {
      setBusy(false);
    }
  }

  const roomLabel = (scene: CameraScene) =>
    rooms.find((r) => r.value === scene)?.label ?? 'No room';
  const urlOk = draft && (draft.id ? true : /^(rtsps?|https?):\/\/[^\s/]+/i.test(draft.url.trim()));

  return (
    <div className="camera-setup">
      <p className="camera-setup-title">Stream cameras</p>
      <p className="camera-setup-note">
        A camera on the network by its stream URL. The server reads it with ffmpeg, so it can watch
        it with no tab open; here you grab frames from it.
      </p>
      {error && <p className="camera-setup-error">{error}</p>}
      {cameras === null && !error && <p className="camera-setup-note">Loading…</p>}
      {cameras && cameras.length > 0 && (
        <ul className="camera-setup-list">
          {cameras.map((c) => (
            <li key={c.id}>
              <div className="camera-setup-row">
                <span className="camera-setup-name">{c.name}</span>
                <span className="camera-setup-room">{roomLabel(c.scene)}</span>
              </div>
              <span className="camera-setup-url">{c.url}</span>
              {preview?.id === c.id && (
                <img
                  className="camera-setup-still"
                  alt={`A still from ${c.name}`}
                  hidden={preview.failed}
                  src={`/api/cameras/${c.id}/snapshot?n=${preview.n}`}
                  onError={() => setPreview({ ...preview, failed: true })}
                />
              )}
              {preview?.id === c.id && preview.failed && (
                <p className="camera-setup-error">
                  No picture came back. Check the URL, its credentials and that ffmpeg is installed.
                </p>
              )}
              <div className="camera-setup-actions">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => onUse(savedStreamId(c.id))}
                >
                  Use
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setPreview({ id: c.id, n: Date.now() })}
                >
                  Check
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    setDraft({
                      id: c.id,
                      name: c.name,
                      url: '',
                      substream: withoutCredentials(c.substream),
                      scene: c.scene,
                    })
                  }
                >
                  Edit
                </Button>
                {removing === c.id ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="destructive"
                      disabled={busy}
                      onClick={() => void remove(c)}
                    >
                      Yes, remove (watching stops if it uses it)
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRemoving(c.id)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <form
          className="camera-setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Name">
            <input
              value={draft.name}
              maxLength={60}
              placeholder="Office camera"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label="Stream URL">
            <input
              value={draft.url}
              maxLength={500}
              spellCheck={false}
              autoComplete="off"
              placeholder={
                draft.id
                  ? 'Leave empty to keep the saved URL'
                  : 'rtsp://user:pass@192.168.1.20/stream1'
              }
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </Field>
          <Field label="Substream URL (optional)">
            <input
              value={draft.substream}
              maxLength={500}
              spellCheck={false}
              autoComplete="off"
              placeholder="rtsp://192.168.1.20/ch1"
              title="A smaller stream of the same view, such as a Thingino camera's ch1: the watcher follows things on it and decodes the full stream only for stills. It uses the stream URL's login."
              onChange={(e) => setDraft({ ...draft, substream: e.target.value })}
            />
          </Field>
          <Field label="Room">
            <Select<string>
              value={draft.scene ?? ''}
              options={[{ value: '', label: 'No room' }, ...rooms]}
              onChange={(v) => setDraft({ ...draft, scene: (v || null) as CameraScene })}
            />
          </Field>
          <div className="camera-setup-actions">
            <Button variant="primary" type="submit" disabled={busy || !draft.name.trim() || !urlOk}>
              {draft.id ? 'Save' : 'Add camera'}
            </Button>
            <Button type="button" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button disabled={busy || cameras === null} onClick={() => setDraft(EMPTY)}>
          Add a camera by URL
        </Button>
      )}
    </div>
  );
}
