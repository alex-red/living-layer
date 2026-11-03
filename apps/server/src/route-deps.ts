import type { LampResult, Mode } from '@livinglayer/domain';
import type { Config } from './config.js';
import type { Jobs } from './jobs.js';
import type { MetaAdapter } from './meta.js';
import type { Runner } from './runs.js';
import type { EvidenceStore } from './store.js';

/** Switches one light or switch, by hand or for a rule; a demo mode answers with the demo's. */
export type Control = (mode: Mode, entityId: string, action: 'on' | 'off') => Promise<LampResult>;

/**
 * What `buildApp` hands the resource plugins. Each plugin takes the part it
 * uses as `Pick<RouteDeps, …>`, so one list says what exists and a plugin's
 * signature says what it needs.
 */
export interface RouteDeps {
  store: EvidenceStore;
  meta: MetaAdapter;
  config: Config;
  /** Runs an operation as a recorded run. */
  run: Runner;
  /** The long jobs the page follows. */
  jobs: Jobs;
  /** The lights and switches rules and fixtures may name. */
  entities: (mode: Mode) => string[];
  /** Switches a fixture's entity. */
  control: Control;
  /** Where looked-up products are kept (`DATA_DIR/products`). */
  productsDir: string;
  /** SAM 3D on a masked crop, giving a splat's PLY bytes; null when it isn't set up. */
  sam3d?: ((crop: Buffer, signal?: AbortSignal) => Promise<Buffer>) | null;
}
