/**
 * Downloads the feature model the watcher uses to find a lost thing again by
 * how it looks, into the data directory, and checks each file's SHA-256.
 * Without it the watcher still runs; lost things go straight to SAM.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../apps/server/src/config.js';
import { APPEARANCE_MODEL } from '../apps/server/src/appearance.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
try {
  const dir = join(loadConfig().dataDir, APPEARANCE_MODEL.dir);
  mkdirSync(dir, { recursive: true });
  for (const file of APPEARANCE_MODEL.files) {
    const path = join(dir, file.name);
    if (existsSync(path) && sha256(readFileSync(path)) === file.sha256) {
      console.log(`${file.name}: already here`);
      continue;
    }
    console.log(`${file.name}: downloading…`);
    const response = await fetch(`${APPEARANCE_MODEL.source}/${file.name}`);
    if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256(bytes) !== file.sha256)
      throw new Error(`${file.name}: the download doesn't match its published checksum.`);
    writeFileSync(`${path}.part`, bytes);
    renameSync(`${path}.part`, path);
    console.log(`${file.name}: ${(bytes.length / 1e6).toFixed(1)} MB, checksum ok`);
  }
  console.log(`${APPEARANCE_MODEL.name} is ready in ${dir}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The model could not be downloaded.');
  process.exitCode = 1;
}
