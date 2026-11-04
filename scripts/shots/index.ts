/** The film's shots, in the order docs/demo-video.md plays them. */
import type { Shot } from '../lib/director.js';
import { brush } from './brush.js';
import { draft } from './draft.js';
import { memory } from './memory.js';
import { tour } from './tour.js';
import { zone } from './zone.js';

export const SHOTS: Shot[] = [tour, draft, zone, brush, memory];
