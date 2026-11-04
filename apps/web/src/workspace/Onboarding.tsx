import { ISO_PRESETS } from '@livinglayer/domain';
import { IsoScene } from '../iso/IsoScene';
import { Button } from '../ui/controls';
import {
  useCalibration,
  useCamera,
  useDesk,
  useFeedback,
  useLabParts,
  useNavigation,
  useObservation,
  useView,
} from './LabContext';
import { pinScene } from './progress';

/**
 * Scene first. The office comes before its desk, because the desk is a close
 * view inside the office and shares its pin. The demo office is one click, so
 * there is never a reason to skip ahead.
 */
export function Onboarding() {
  const lab = useLabParts(useView(), useFeedback(), useDesk(), useCamera(), useNavigation());
  const { mode, memory, workScene, busy, camera, cameraPending, metaReady } = lab;
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
              An office with a desk, a chair and a shelf, seen by a virtual corner camera. No camera
              or key needed.
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
                ? 'Scan the office through the demo camera, with no model calls.'
                : 'Spark lists what is in the photo, SAM outlines it, and you review the layout. About 2 billed calls.'}
            </span>
          </span>
        </button>
      </div>
      {mode === 'demo' && (
        <div className="onboarding-own">
          <Button
            disabled={Boolean(busy) || camera || cameraPending || !metaReady}
            onClick={() => lab.draftOwnPhoto()}
          >
            Use your own photo
          </Button>
          <span className="micro">
            {metaReady
              ? 'Switches to Live and drafts the office from a photo you upload. About 2 billed calls.'
              : 'Live calls aren’t available: set MODEL_API_KEY and META_LIVE_ENABLED, or raise today’s spend limit.'}
          </span>
        </div>
      )}
      <div className="onboarding-more">
        <span className="tiny">OTHER SCENES</span>
        <Button variant="text" onClick={() => lab.pickScene('fridge')}>
          Fridge
        </Button>
        <Button variant="text" onClick={() => lab.pickScene('home')}>
          Home
        </Button>
        <Button variant="text" onClick={() => lab.pickScene('litter')}>
          Litter box room
        </Button>
        {memory?.scene && (
          <Button variant="text" onClick={() => lab.pickScene('custom')}>
            {memory.scene.label} (yours)
          </Button>
        )}
        {workScene && (
          <Button onClick={() => lab.setChoosingScene(false)}>Keep the current scene</Button>
        )}
      </div>
    </div>
  );
}

/**
 * Step 2, in live mode: the office is set, but its corner camera isn't
 * calibrated yet. Calibrating pins the desk too. The demo camera comes
 * calibrated, so this never shows there.
 */
export function DeskStep() {
  const lab = useLabParts(
    useView(),
    useFeedback(),
    useDesk(),
    useCamera(),
    useObservation(),
    useCalibration(),
  );
  const { image, camera, busy, cameraPending, progress } = lab;
  // Not while the room itself is being drafted: the desk comes after.
  if (
    !progress.view ||
    !progress.deskId ||
    progress.pinned ||
    lab.mode !== 'live' ||
    lab.isoPanel === 'scene'
  )
    return null;
  const desk = { scene: pinScene(progress.view), surfaceId: progress.deskId };
  if (lab.memory?.camera || lab.calibrating) return null;
  return (
    <div className="desk-step" role="note" aria-label="Calibrate the room's camera">
      <span className="tiny">STEP 2 OF 2 · THE CAMERA</span>
      <p>
        <strong>Mount the camera high in a corner, looking across the room.</strong>{' '}
        {camera
          ? 'Capture a frame once it is fixed in place.'
          : image
            ? 'Calibrate it on this frame: SAM outlines the floor and walls (two billed calls), then drag the far corner and each wall’s floor line into place and give the room’s size. The desk is pinned where the camera sees it.'
            : 'Use the camera, or upload a frame from it. It stays where it is from now on: everything Living Layer watches is placed through it.'}
      </p>
      <div className="save-actions">
        {image && !camera ? (
          <>
            <Button
              variant="primary"
              disabled={Boolean(busy)}
              onClick={() => void lab.startCalibrating()}
            >
              {busy === 'calibrate' ? 'Outlining the floor…' : 'Calibrate the camera'}
            </Button>
            <Button
              disabled={Boolean(busy)}
              onClick={() => lab.setPinning({ ...desk, label: 'desktop' })}
            >
              Pin the desk by hand
            </Button>
          </>
        ) : (
          !camera && (
            <>
              <Button
                variant="primary"
                disabled={Boolean(busy) || cameraPending}
                onClick={() => void lab.startCamera()}
              >
                Use the camera
              </Button>
              <Button disabled={Boolean(busy)} onClick={() => lab.file.current?.click()}>
                Upload a frame
              </Button>
            </>
          )
        )}
        <Button
          variant="text"
          disabled={Boolean(busy) || camera}
          onClick={() => lab.changeMode('demo')}
        >
          Try the demo desk instead
        </Button>
      </div>
    </div>
  );
}
