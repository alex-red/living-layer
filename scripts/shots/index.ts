/** The film's shots, in the order docs/demo-video.md plays them. */
import type { Shot } from '../lib/director.js';
import { brush } from './brush.js';
import { coach } from './coach.js';
import { draft } from './draft.js';
import { end } from './end.js';
import { memory } from './memory.js';
import { plushies } from './plushies.js';
import { remembers } from './remembers.js';
import { tour } from './tour.js';
import { zone } from './zone.js';

export const SHOTS: Shot[] = [tour, draft, zone, brush, memory, end, remembers, plushies, coach];
