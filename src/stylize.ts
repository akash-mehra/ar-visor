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
  /** Which execution provider started, and the size actually being run. */
  note: string;
  submit(src: CanvasImageSource, box: Box): void;
};

type Layout = 'nchw' | 'nhwc';

/** Both ends of a tensor. */
function range(a: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of a) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

const show = ([lo, hi]: [number, number]) => `${lo.toFixed(2)}…${hi.toFixed(2)}`;

export async function loadStylizer(
  url: string,
  wasmBase?: string,
  only?: string | null
): Promise<Stylizer> {
  const state: Stylizer = {
    out: null,
    ms: 0,
    error: null,
    note: '',
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

  // An HTML error page arrives as a perfectly good ArrayBuffer, so the bytes
  // have to be checked before the runtime is blamed for not loading them.
  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    const type = (res.headers.get('content-type') ?? '?').split(';')[0];
    const buf = await res.arrayBuffer();
    const kb = Math.round(buf.byteLength / 1024);
    if (!res.ok) throw new Error(`HTTP ${res.status} (${type}, ${kb}KB)`);
    if (buf.byteLength < 100_000) throw new Error(`got ${kb}KB of ${type}, not a model`);
    bytes = new Uint8Array(buf);
  } catch (e) {
    state.error = `fetch: ${(e as Error).message}`;
    return state;
  }

  // Each provider's own complaint is the useful part; swallowing them and
  // reporting "none would start" says nothing about why.
  const failed: string[] = [];
  // WebGPU is both the fastest provider and the least mature one: a kernel it
  // gets wrong still returns a perfectly well-formed tensor. `?ep=wasm` pins
  // the reference implementation, which is the only way to tell a bad kernel
  // apart from a bad input without a second device to compare against.
  for (const ep of only ? [only] : ['webgpu', 'webgl', 'wasm']) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
      backend = ep;
      break;
    } catch (e) {
      failed.push(`${ep}: ${(e as Error).message.slice(0, 70)}`);
    }
  }
  if (!backend) {
    state.error = failed[failed.length - 1] ?? 'no provider started';
    console.error('stylizer providers failed:', failed);
    return state;
  }

  // Read the contract off the model rather than assuming it.
  const inName = session!.inputNames[0];
  const outName = session!.outputNames[0];
  const meta = session!.inputMetadata?.[0];
  const dims = meta && 'shape' in meta ? (meta.shape as readonly (number | string)[]) : undefined;
  // NHWC puts the channel last; anything else is treated as NCHW.
  const layout: Layout = dims?.[3] === 3 ? 'nhwc' : 'nchw';
  // A model exported at a fixed size rejects every other size, so run at what
  // it declares and only fall back to SIZE where the axis is dynamic — those
  // come through as strings like "height" rather than numbers.
  const declared = dims?.[layout === 'nchw' ? 2 : 1];
  const size = typeof declared === 'number' && declared > 0 ? declared : SIZE;

  const crop = document.createElement('canvas');
  crop.width = size;
  crop.height = size;
  const cropCtx = crop.getContext('2d', { willReadFrequently: true })!;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const outCtx = out.getContext('2d')!;
  const data = new Float32Array(size * size * 3);
  let busy = false;
  // Whether the output is [-1, 1] or [0, 1]; latched off the first frame.
  let signed: boolean | null = null;

  state.submit = (src, box) => {
    if (busy || state.error || box.w < 8 || box.h < 8) return;
    busy = true;
    cropCtx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, size, size);
    const px = cropCtx.getImageData(0, 0, size, size).data;
    const n = size * size;
    // AnimeGANv2 takes [-1, 1].
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
    const shape = layout === 'nchw' ? [1, 3, size, size] : [1, size, size, 3];
    // A flat output over a live input is a broken kernel; a flat output over a
    // flat input is a broken crop. The two want opposite fixes, so both ends
    // of both tensors go on the status line rather than being guessed at.
    const inRange = show(range(data));
    const started = performance.now();
    session
      .run({ [inName]: new ort.Tensor('float32', data, shape) })
      .then((res) => {
        const y = res[outName].data as Float32Array;
        // Upstream AnimeGANv2 emits [-1, 1] and face2paint denormalises it;
        // this export bakes that in and hands back [0, 1] already. Reading it
        // as [-1, 1] folded the whole picture into the top half of the range,
        // which is the cream wash. Latched off the first frame rather than
        // hardcoded, because the model URL is the thing most likely to change
        // and a stylised frame always has something dark in it.
        const outRange = range(y);
        if (signed === null) signed = outRange[0] < -0.01;
        const shift = signed ? 1 : 0;
        const scale = signed ? 127.5 : 255;
        const img = outCtx.createImageData(size, size);
        for (let i = 0; i < n; i++) {
          const [r, g, b] =
            layout === 'nchw' ? [y[i], y[n + i], y[2 * n + i]] : [y[i * 3], y[i * 3 + 1], y[i * 3 + 2]];
          img.data[i * 4] = (r + shift) * scale;
          img.data[i * 4 + 1] = (g + shift) * scale;
          img.data[i * 4 + 2] = (b + shift) * scale;
          img.data[i * 4 + 3] = 255;
        }
        outCtx.putImageData(img, 0, 0);
        state.out = out;
        state.ms = Math.round(performance.now() - started);
        state.note = `${backend} ${size}px · in ${inRange} · out ${show(outRange)}`;
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
  state.note = `${backend} ${size}px`;
  return state;
}
