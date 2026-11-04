import { availableParallelism } from 'node:os';
import {
  fitItem,
  refitRecipe,
  renderRoom,
  type Bits,
  type FitInput,
  type FitOutput,
  type FixtureRecipe,
  type IsoScene,
  type RecipePlace,
  type RoomCamera,
  type RoomPicture,
  type RoomSolid,
} from '@livinglayer/domain';

export type ComputeJob =
  | { op: 'fit'; input: FitInput }
  | {
      op: 'render';
      camera: RoomCamera;
      solids: RoomSolid[];
      options?: { labels?: boolean; scratch?: boolean };
    }
  | {
      op: 'refit';
      camera: RoomCamera;
      scene: IsoScene;
      recipe: FixtureRecipe;
      place: RecipePlace;
      outline: Bits;
    };

/**
 * A fit takes 150 to 300 ms, a render 70 to 150 ms and a refit seconds of one thread, long
 * enough to stall every other request, so they run in a few Bun Workers
 * (results are byte-identical: the same pure functions). Tests and
 * `COMPUTE_WORKERS=0` run them in place; `COMPUTE_WORKERS=<n>` sets the pool size.
 */
function poolSize(): number {
  const configured = process.env.COMPUTE_WORKERS;
  if (configured !== undefined) return Math.max(0, Math.floor(Number(configured)) || 0);
  if (process.env.NODE_ENV === 'test') return 0;
  return Math.min(2, Math.max(1, availableParallelism() - 1));
}

interface Pending {
  id: number;
  job: ComputeJob;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}
interface Slot {
  worker: Worker;
  busy: Pending | null;
}
const slots: Slot[] = [];
const waiting: Pending[] = [];
let nextId = 1;

function spawn(): Slot {
  const worker = new Worker(new URL('./compute-worker.ts', import.meta.url).href);
  (worker as { unref?: () => void }).unref?.();
  const slot: Slot = { worker, busy: null };
  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const job = slot.busy;
    slot.busy = null;
    if (job?.id === event.data.id) {
      if (event.data.error !== undefined) job.reject(new Error(event.data.error));
      else job.resolve(event.data.result as never);
    }
    drain();
  };
  worker.onerror = (event) => {
    // A crashed worker: fail its job (which then runs in place) and replace it.
    const job = slot.busy;
    slot.busy = null;
    slots.splice(slots.indexOf(slot), 1);
    job?.reject(new Error(`compute worker failed: ${event.message}`));
    drain();
  };
  slots.push(slot);
  return slot;
}
function drain() {
  const size = poolSize();
  while (waiting.length) {
    const slot = slots.find((s) => !s.busy) ?? (slots.length < size ? spawn() : undefined);
    if (!slot) return;
    const next = waiting.shift()!;
    slot.busy = next;
    slot.worker.postMessage({ id: next.id, job: next.job });
  }
}
function run<T>(job: ComputeJob, inPlace: () => T): Promise<T> {
  if (poolSize() === 0) return Promise.resolve().then(inPlace);
  return new Promise<T>((resolve, reject) => {
    waiting.push({ id: nextId++, job, resolve: resolve as never, reject });
    drain();
  }).catch(() => inPlace()); // a failed worker costs speed, not the request
}

export const fitItemAsync = (input: FitInput): Promise<FitOutput> =>
  run({ op: 'fit', input }, () => fitItem(input));
export const renderRoomAsync = (
  camera: RoomCamera,
  solids: RoomSolid[],
  options?: { labels?: boolean; scratch?: boolean },
): Promise<RoomPicture> =>
  run({ op: 'render', camera, solids, ...(options ? { options } : {}) }, () =>
    renderRoom(camera, solids, options),
  );
/** A model's size refitted to its outline: about 160 room renders, a few seconds. */
export const refitRecipeAsync = (
  camera: RoomCamera,
  scene: IsoScene,
  recipe: FixtureRecipe,
  place: RecipePlace,
  outline: Bits,
): Promise<ReturnType<typeof refitRecipe>> =>
  run({ op: 'refit', camera, scene, recipe, place, outline }, () =>
    refitRecipe(camera, scene, recipe, place, outline),
  );
export function closeCompute(): void {
  for (const { worker } of slots.splice(0)) worker.terminate();
}
