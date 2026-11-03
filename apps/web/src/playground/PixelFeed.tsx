import { useEffect, useRef, useState, type RefObject } from 'react';

export type PixelPalette = 'full' | 'neon' | 'mono';

/** Fixed palettes, as sRGB hex. `full` posterizes each channel instead. */
const PALETTES: Record<Exclude<PixelPalette, 'full'>, string[]> = {
  // The Quiet Neon tokens, from the void up to text.
  neon: [
    '#0a0c12',
    '#181c28',
    '#212637',
    '#7c8299',
    '#a9aec2',
    '#ece9f2',
    '#6fd3e0',
    '#e68cc4',
    '#ffb866',
    '#86d9aa',
    '#ae9bf5',
    '#f27c83',
  ],
  mono: ['#0a0c12', '#3b4257', '#8a91a8', '#ece9f2'],
};

const SHADER = /* wgsl */ `
struct Params {
  grid: vec2f,
  levels: f32,
  dither: f32,
  count: u32,
  palette: array<vec4f, 16>,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var frame: texture_external;
@group(0) @binding(2) var<uniform> p: Params;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> Out {
  // One triangle that covers the whole canvas.
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Out;
  out.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}

const BAYER = array<f32, 16>(0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let cell = floor(in.uv * p.grid);
  // Average four taps inside the block so fine texture does not shimmer.
  let step = 0.25 / p.grid;
  let center = (cell + 0.5) / p.grid;
  var c = (textureSampleBaseClampToEdge(frame, samp, center + vec2f(-step.x, -step.y)).rgb
    + textureSampleBaseClampToEdge(frame, samp, center + vec2f(step.x, -step.y)).rgb
    + textureSampleBaseClampToEdge(frame, samp, center + vec2f(-step.x, step.y)).rgb
    + textureSampleBaseClampToEdge(frame, samp, center + vec2f(step.x, step.y)).rgb) * 0.25;

  let b = vec2u(cell) % 4u;
  let threshold = (BAYER[b.y * 4u + b.x] + 0.5) / 16.0 - 0.5;

  if (p.count == 0u) {
    let n = p.levels - 1.0;
    c = floor(c * n + 0.5 + threshold * p.dither) / n;
    return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
  }

  c = c + threshold * p.dither * 0.18;
  var best = p.palette[0].rgb;
  var bestDistance = 1e9;
  for (var i = 0u; i < p.count; i++) {
    // Weight green the most, as the eye does.
    let d = (p.palette[i].rgb - c) * vec3f(0.3, 0.59, 0.11);
    let distance = dot(d, d);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p.palette[i].rgb;
    }
  }
  return vec4f(best, 1.0);
}
`;

const supported = typeof navigator !== 'undefined' && 'gpu' in navigator;

/**
 * Draws the live video through a WebGPU pixel-art shader. Each frame is
 * imported as an external texture, so it never round-trips through the CPU.
 * The video element itself is untouched, so captures stay unfiltered.
 */
export function PixelFeed({
  video,
  active,
  blockPx,
  palette,
  dither,
}: {
  video: RefObject<HTMLVideoElement | null>;
  active: boolean;
  /** Size of one art pixel in source video pixels. */
  blockPx: number;
  palette: PixelPalette;
  dither: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const settings = useRef({ blockPx, palette, dither });
  settings.current = { blockPx, palette, dither };
  const [error, setError] = useState(supported ? '' : 'WebGPU is not available in this browser.');

  useEffect(() => {
    const el = canvas.current;
    if (!active || !supported || !el) return;
    let stopped = false;
    let device: GPUDevice | undefined;
    let frameHandle = 0;
    let viaVideoFrames = false;

    void (async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (stopped) return;
      if (!adapter) return setError('No WebGPU adapter was found.');
      device = await adapter.requestDevice();
      if (stopped) return device.destroy();
      const gpu = device;
      void gpu.lost.then((info) => {
        if (!stopped && info.reason !== 'destroyed') setError('The GPU device was lost.');
      });

      const context = el.getContext('webgpu');
      if (!context) return setError('Could not create a WebGPU canvas.');
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device: gpu, format, alphaMode: 'opaque' });

      const module = gpu.createShaderModule({ code: SHADER });
      const pipeline = gpu.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      });
      const sampler = gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      const uniforms = new ArrayBuffer(16 * 4 + 16 * 16);
      const floats = new Float32Array(uniforms);
      const uints = new Uint32Array(uniforms);
      const buffer = gpu.createBuffer({
        size: uniforms.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const draw = () => {
        if (stopped) return;
        const source = video.current;
        if (source && source.readyState >= source.HAVE_CURRENT_DATA && source.videoWidth) {
          if (el.width !== source.videoWidth || el.height !== source.videoHeight) {
            el.width = source.videoWidth;
            el.height = source.videoHeight;
          }
          const { blockPx: size, palette: name, dither: on } = settings.current;
          floats[0] = Math.max(1, Math.round(source.videoWidth / size));
          floats[1] = Math.max(1, Math.round(source.videoHeight / size));
          floats[2] = 5;
          floats[3] = on ? 1 : 0;
          const colours = name === 'full' ? [] : PALETTES[name];
          uints[4] = colours.length;
          colours.forEach((hex, i) => {
            const value = parseInt(hex.slice(1), 16);
            floats.set(
              [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1],
              8 + i * 4,
            );
          });
          gpu.queue.writeBuffer(buffer, 0, uniforms);

          // An external texture is only valid for the current task, so it is
          // imported, bound and drawn in one go.
          const bindGroup = gpu.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: sampler },
              { binding: 1, resource: gpu.importExternalTexture({ source }) },
              { binding: 2, resource: { buffer } },
            ],
          });
          const encoder = gpu.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              },
            ],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.draw(3);
          pass.end();
          gpu.queue.submit([encoder.finish()]);
        }
        schedule();
      };

      // Draw once per decoded camera frame where the browser can say when that is.
      const schedule = () => {
        const source = video.current;
        viaVideoFrames = !!source && 'requestVideoFrameCallback' in source;
        frameHandle = viaVideoFrames
          ? source!.requestVideoFrameCallback(draw)
          : requestAnimationFrame(draw);
      };
      setError('');
      schedule();
    })().catch(() => {
      if (!stopped) setError('The pixel-art renderer failed to start.');
    });

    return () => {
      stopped = true;
      // The element the frame callback was set on is the one in the ref now.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (viaVideoFrames) video.current?.cancelVideoFrameCallback(frameHandle);
      else cancelAnimationFrame(frameHandle);
      device?.destroy();
    };
  }, [active, video]);

  if (!active) return null;
  return (
    <>
      <canvas ref={canvas} className="pg-pixel" hidden={!!error} aria-hidden="true" />
      {error && <p className="pg-pixel-error">{error}</p>}
    </>
  );
}
