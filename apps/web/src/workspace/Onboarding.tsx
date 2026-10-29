import { ISO_PRESETS } from '@livinglayer/domain';
import { IsoScene } from '../iso/IsoScene';
import { useLab } from './LabContext';

/**
 * Scene first. The office comes before its desk, because the desk is a close
 * view inside the office and shares its pin. The demo office is one click, so
 * there is never a reason to skip ahead.
 */
export function Onboarding() {
  const lab = useLab();
  const { mode, memory, workScene, busy } = lab;
  const office = ISO_PRESETS.office;
  return (
    <div className="onboarding" role="group" aria-label="Choose a scene">
      <div className="onboarding-head">
        <span className="tiny">STEP 1 OF 2 · THE ROOM</span>
        <h2>Start with your office.</h2>
        <p>
          Living Layer keeps a small map of the room. Set up the whole office first; the desk comes
          next, as a close view inside it.
        </p>
      </div>
      <div className="onboarding-cards">
        <button
          className="scene-card onboarding-card"
          aria-label="Use the demo office"
          disabled={Boolean(busy)}
          onClick={() => lab.pickScene('office')}
        >
          <span className="scene-card-art" aria-hidden="true">
            <IsoScene scene={office} />
          </span>
          <span className="scene-card-text">
            <span className="tiny">QUICKEST</span>
            <strong>Use the demo office</strong>
            <span>
              An illustrated office with a desk, a chair and a shelf. No camera or key needed.
            </span>
          </span>
        </button>
        <button
          className="scene-card onboarding-card"
          aria-label={mode === 'demo' ? 'Draft from the demo photo' : 'Photograph your office'}
          disabled={Boolean(busy)}
          onClick={() => lab.pickScene('office', 'photo')}
        >
          <span className="scene-card-art photo-art" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
          </span>
          <span className="scene-card-text">
            <span className="tiny">{mode === 'demo' ? 'DEMO PHOTO' : 'YOUR ROOM'}</span>
            <strong>
              {mode === 'demo' ? 'Draft from the demo photo' : 'Photograph your office'}
            </strong>
            <span>
              {mode === 'demo'
                ? 'Run the photo-to-scene pipeline on the illustrated desk, with no model calls.'
                : 'Spark lists what is in the photo, SAM outlines it, and you review the layout. About 2 billed calls.'}
            </span>
          </span>
        </button>
      </div>
      <div className="onboarding-more">
        <span className="tiny">OTHER SCENES</span>
        <button className="text-button" onClick={() => lab.pickScene('fridge')}>
          Fridge
        </button>
        {memory?.scene && (
          <button className="text-button" onClick={() => lab.pickScene('custom')}>
            {memory.scene.label} (yours)
          </button>
        )}
        {workScene && (
          <button className="secondary" onClick={() => lab.setChoosingScene(false)}>
            Keep the current scene
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Step 2, in live mode: the office is set, but the desk isn't pinned to a
 * camera frame yet. The demo desk comes pinned, so this never shows there.
 */
export function DeskStep() {
  const lab = useLab();
  const { image, camera, busy, cameraPending, progress } = lab;
  if (!progress.view || progress.pinned || lab.mode !== 'live') return null;
  return (
    <div className="desk-step" role="note" aria-label="Set up the office desk">
      <span className="tiny">STEP 2 OF 2 · THE DESK</span>
      <p>
        <strong>Now get close to the desk.</strong>{' '}
        {camera
          ? 'Capture a frame when the desktop fills the view.'
          : image
            ? 'Find its top on the photo: SAM outlines the desk and its corners are measured for you to check. One billed call.'
            : 'Point the camera at the desktop, or upload a close photo. This is the view the lamp rule watches.'}
      </p>
      <div className="save-actions">
        {image && !camera ? (
          <>
            <button
              className="primary"
              disabled={Boolean(busy)}
              onClick={() =>
                void lab.autoPin({ scene: progress.view!, surfaceId: 'desk:top', label: 'desktop' })
              }
            >
              {busy === 'autopin' ? 'Finding the desktop…' : 'Find the desktop'}
            </button>
            <button
              className="secondary"
              disabled={Boolean(busy)}
              onClick={() =>
                lab.setPinning({ scene: progress.view!, surfaceId: 'desk:top', label: 'desktop' })
              }
            >
              Pin by hand
            </button>
          </>
        ) : (
          !camera && (
            <>
              <button
                className="primary"
                disabled={Boolean(busy) || cameraPending}
                onClick={() => void lab.startCamera()}
              >
                Use the camera
              </button>
              <button
                className="secondary"
                disabled={Boolean(busy)}
                onClick={() => lab.file.current?.click()}
              >
                Upload a close photo
              </button>
            </>
          )
        )}
        <button
          className="text-button"
          disabled={Boolean(busy) || camera}
          onClick={() => lab.changeMode('demo')}
        >
          Try the demo desk instead
        </button>
      </div>
    </div>
  );
}
