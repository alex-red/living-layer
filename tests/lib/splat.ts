/**
 * A synthetic splat of a mug, as SAM 3D would send it: a binary PLY of
 * points on its outer wall, inner wall and floor, and a handle's loop on
 * the +x side, with z up. Its body tapers from `base` to 1 (shares of the
 * rim's radius) over `height` (in rim radii).
 */
export function mugSplat({
  height = 2.3,
  base = 0.8,
  handle = true,
}: { height?: number; base?: number; handle?: boolean } = {}): Buffer {
  const points: [number, number, number][] = [];
  const radius = (z: number) => base + (1 - base) * (z / height);
  for (let i = 0; i < 60; i++) {
    const z = (i / 59) * height;
    for (let j = 0; j < 72; j++) {
      const a = (j / 72) * Math.PI * 2;
      const r = radius(z);
      points.push([r * Math.cos(a), r * Math.sin(a), z]);
      if (z > 0.15) points.push([0.9 * r * Math.cos(a), 0.9 * r * Math.sin(a), z]);
    }
  }
  for (let i = 0; i < 20; i++)
    for (let j = 0; j < 36; j++) {
      const r = (i / 20) * base;
      const a = (j / 36) * Math.PI * 2;
      points.push([r * Math.cos(a), r * Math.sin(a), 0.15]);
    }
  if (handle)
    // A half loop standing out from the body between 30% and 85% of the height.
    for (let i = 0; i < 200; i++) {
      const t = (i / 199) * Math.PI;
      const mid = height * 0.575;
      const reachZ = height * 0.275;
      const z = mid + reachZ * Math.cos(t);
      const x = radius(z) * 0.95 + 0.7 * Math.sin(t);
      for (let k = -2; k <= 2; k++) points.push([x, k * 0.03, z]);
    }
  return ply(points);
}

/** A splat of a turned body's own shape: its profile turned about z, at its radius and height. */
export function latheSplat(fit: {
  radius: number;
  height: number;
  profile: { r: number; z: number }[];
}): Buffer {
  const points: [number, number, number][] = [];
  const at = (z: number) => {
    const p = fit.profile;
    for (let i = 1; i < p.length; i++)
      if (p[i]!.z >= z) {
        const a = p[i - 1]!;
        const b = p[i]!;
        return a.r + ((b.r - a.r) * (z - a.z)) / (b.z - a.z || 1);
      }
    return p.at(-1)!.r;
  };
  for (let i = 0; i < 80; i++) {
    const z = i / 79;
    for (let j = 0; j < 72; j++) {
      const a = (j / 72) * Math.PI * 2;
      const r = fit.radius * at(z);
      points.push([r * Math.cos(a), r * Math.sin(a), z * fit.height]);
    }
  }
  return ply(points);
}

function ply(points: [number, number, number][]): Buffer {
  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${points.length}\n` +
    'property float x\nproperty float y\nproperty float z\nproperty float opacity\nend_header\n';
  const body = Buffer.alloc(points.length * 16);
  points.forEach(([x, y, z], i) => {
    body.writeFloatLE(x, i * 16);
    body.writeFloatLE(y, i * 16 + 4);
    body.writeFloatLE(z, i * 16 + 8);
    // Splats keep opacity as a logit: 4 is about 0.98.
    body.writeFloatLE(4, i * 16 + 12);
  });
  return Buffer.concat([Buffer.from(header, 'latin1'), body]);
}
