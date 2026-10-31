import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { embedSize, type PatchGrid, type UnitBox } from '@livinglayer/domain';

/**
 * DINOv3 ViT-S/16, int8 (Meta, via onnx-community), about 22 MB. Downloaded
 * once by `bun run fetch-model` into the data directory, never bundled; each
 * file is checked against its published SHA-256.
 */
export const APPEARANCE_MODEL = {
  name: 'DINOv3 ViT-S/16 (int8)',
  dir: 'models/dinov3-vits16',
  source:
    'https://huggingface.co/onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX/resolve/main/onnx',
  files: [
    {
      name: 'model_quantized.onnx',
      sha256: '7686e8c849202c4fdd67d1cd336449c29bdddbcca535d765d3014f50d04d516d',
    },
    {
      name: 'model_quantized.onnx_data',
      sha256: '51572f7fc3c272eb574a70509ea1eeb7e674e5ca2cd96fec1632edb38983d529',
    },
  ],
  /** The class token and four register tokens come before the patches. */
  leadingTokens: 5,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
} as const;

export const appearanceModelPath = (dataDir: string) =>
  join(dataDir, APPEARANCE_MODEL.dir, APPEARANCE_MODEL.files[0].name);

type Ort = typeof import('onnxruntime-node');

/**
 * The feature model, run on the CPU: about 12 ms for a 224 px image and 45 ms
 * for 448 px on an M-series Mac, faster than CoreML for this int8 model.
 */
export class Appearance {
  private queue = Promise.resolve();
  private constructor(
    private ort: Ort,
    private session: Awaited<ReturnType<Ort['InferenceSession']['create']>>,
  ) {}
  /** The model, or null when its files aren't there or it can't be loaded. Never throws. */
  static async load(dataDir: string): Promise<Appearance | null> {
    const path = appearanceModelPath(dataDir);
    if (!existsSync(path)) return null;
    try {
      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(path, { executionProviders: ['cpu'] });
      return new Appearance(ort, session);
    } catch {
      return null;
    }
  }
  /** Patch features of an image, or of `region` of it (a share of the image). One run at a time. */
  embed(image: Buffer, region?: UnitBox, side?: number): Promise<PatchGrid> {
    const next = this.queue.then(() => this.run(image, region, side));
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async run(image: Buffer, region?: UnitBox, side?: number): Promise<PatchGrid> {
    let picture = sharp(image).removeAlpha();
    const { width: W = 1, height: H = 1 } = await sharp(image).metadata();
    let w = W;
    let h = H;
    if (region) {
      const left = Math.max(0, Math.floor(region.x * W));
      const top = Math.max(0, Math.floor(region.y * H));
      w = Math.max(1, Math.min(W - left, Math.round(region.width * W)));
      h = Math.max(1, Math.min(H - top, Math.round(region.height * H)));
      picture = picture.extract({ left, top, width: w, height: h });
    }
    const size = embedSize(w, h, side);
    const { data } = await picture
      .resize(size.width, size.height, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const n = size.width * size.height;
    const input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++)
        input[c * n + i] =
          (data[i * 3 + c]! / 255 - APPEARANCE_MODEL.mean[c]!) / APPEARANCE_MODEL.std[c]!;
    const tensor = new this.ort.Tensor('float32', input, [1, 3, size.height, size.width]);
    const out = await this.session.run({ [this.session.inputNames[0]!]: tensor });
    const hidden = out[this.session.outputNames[0]!]!;
    const dim = hidden.dims[2]!;
    const cols = size.width / 16;
    const rows = size.height / 16;
    const all = hidden.data as Float32Array;
    return {
      cols,
      rows,
      dim,
      data: all.slice(
        APPEARANCE_MODEL.leadingTokens * dim,
        (APPEARANCE_MODEL.leadingTokens + cols * rows) * dim,
      ),
    };
  }
}
