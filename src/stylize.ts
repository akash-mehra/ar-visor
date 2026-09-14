import * as ort from 'onnxruntime-web';
import { type Box } from './gesture';

/**
 * Neural stylisation of the framed region.
 *
 * The model is fully convolutional, so it runs at whatever size we hand it;
 * SIZE trades fidelity against latency and is the first dial to turn if the
 * device cannot keep up. Inference never blocks the draw loop — a frame is
 * submitted, the loop carries on, and the most recent result is composited
 * until the next one lands. The picture inside the frame therefore lags by
 * one inference, which is the price of a camera that still feels live.
 */
const SIZE = 256;

export type Stylizer = {
  /** Most recent styled frame, or null until the first one lands. */
  out: HTMLCanvasElement | null;
  /** Milliseconds the last inference took. */
  ms: number;
  /** Non-null once something has gone wrong, for the status line. */
  error: string | null;
  submit(src: CanvasImageSource, box: Box): void;
};

type Layout = 'nchw' | 'nhwc';

export async function loadStylizer(url: string, wasmBase?: string): Promise<Stylizer> {
  const state: Stylizer = {
    out: null,
    ms: 0,
    error: null,
    submit: () => {}
  };

  // Threads need COOP/COEP headers, which a Pages site cannot send, so ask for
  // one and skip the threaded build rather than let it fail on its own.
  ort.env.wasm.numThreads = 1;
  // The package does not export its .wasm through `exports`, so the bundler
  // cannot emit it; the runtime fetches it instead. Pinned to whatever version
  // is installed, so the two cannot drift apart silently. It is 27 MB raw —
  // keeping it off our own bundle is the point, and the CDN caches it.
  ort.env.wasm.wasmPaths =
    wasmBase ?? `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.common}/dist/`;

  let session: ort.InferenceSession;
  let backend = '';
  try {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    // In order of preference; a device without WebGPU still gets a picture.
    for (const ep of ['webgpu', 'webgl', 'wasm']) {
      try {
        session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
        backend = ep;
        break;
      } catch {
        /* try the next one */
      }
    }
    if (!backend) throw new Error('no execution provider would start');
  } catch (e) {
    state.error = `model: ${(e as Error).message}`;
    return state;
  }

  // Read the contract off the model rather than assuming it.
  const inName = session!.inputNames[0];
  const outName = session!.outputNames[0];
  const meta = session!.inputMetadata?.[0];
  const dims = meta && 'shape' in meta ? (meta.shape as readonly (number | string)[]) : undefined;
  // NHWC puts the channel last; anything else is treated as NCHW.
  const layout: Layout = dims?.[3] === 3 ? 'nhwc' : 'nchw';

  const crop = document.createElement('canvas');
  crop.width = SIZE;
  crop.height = SIZE;
  const cropCtx = crop.getContext('2d', { willReadFrequently: true })!;
  const out = document.createElement('canvas');
  out.width = SIZE;
  out.height = SIZE;
  const outCtx = out.getContext('2d')!;
  const data = new Float32Array(SIZE * SIZE * 3);
  let busy = false;

  state.submit = (src, box) => {
    if (busy || state.error || box.w < 8 || box.h < 8) return;
    busy = true;
    cropCtx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, SIZE, SIZE);
    const px = cropCtx.getImageData(0, 0, SIZE, SIZE).data;
    const n = SIZE * SIZE;
    // AnimeGANv2 takes and returns [-1, 1].
    for (let i = 0; i < n; i++) {
      const r = px[i * 4] / 127.5 - 1;
      const g = px[i * 4 + 1] / 127.5 - 1;
      const b = px[i * 4 + 2] / 127.5 - 1;
      if (layout === 'nchw') {
        data[i] = r;
        data[n + i] = g;
        data[2 * n + i] = b;
      } else {
        data[i * 3] = r;
        data[i * 3 + 1] = g;
        data[i * 3 + 2] = b;
      }
    }
    const shape = layout === 'nchw' ? [1, 3, SIZE, SIZE] : [1, SIZE, SIZE, 3];
    const started = performance.now();
    session
      .run({ [inName]: new ort.Tensor('float32', data, shape) })
      .then((res) => {
        const y = res[outName].data as Float32Array;
        const img = outCtx.createImageData(SIZE, SIZE);
        for (let i = 0; i < n; i++) {
          const [r, g, b] =
            layout === 'nchw' ? [y[i], y[n + i], y[2 * n + i]] : [y[i * 3], y[i * 3 + 1], y[i * 3 + 2]];
          img.data[i * 4] = (r + 1) * 127.5;
          img.data[i * 4 + 1] = (g + 1) * 127.5;
          img.data[i * 4 + 2] = (b + 1) * 127.5;
          img.data[i * 4 + 3] = 255;
        }
        outCtx.putImageData(img, 0, 0);
        state.out = out;
        state.ms = Math.round(performance.now() - started);
      })
      .catch((e: Error) => {
        state.error = `run: ${e.message}`;
      })
      .finally(() => {
        busy = false;
      });
  };

  state.error = null;
  state.ms = 0;
  (state as { backend?: string }).backend = backend;
  return state;
}
