import { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import { coverFit, onScreen, type Pt } from './gesture';

/**
 * Everything floating over the camera.
 *
 * The canvas is the page and this is the chrome on top of it, so the module
 * owns its own DOM and hands `main` a small set of verbs. The one thing that
 * genuinely crosses the boundary is coordinates: labels live in CSS pixels,
 * bones live in canvas pixels, and the canvas is both mirrored and
 * `object-fit: cover`-cropped between the two — so every position goes through
 * onScreen rather than being guessed at.
 */

export type Hooks = {
  /** A bone was tapped in the list. */
  pick(i: number): void;
  /** The slider moved. */
  zoom(z: number): void;
};

export type Ui = {
  /** Reveal the chrome once there is a camera behind it. */
  begin(): void;
  /** Fill the bone list. Called once the model's names are known. */
  listBones(names: string[], colours: string[]): void;
  /** Point the label at a bone, or hide it. `at` is in canvas pixels. */
  label(name: string | null, at: Pt | null, cw: number, ch: number): void;
  /** Which bone the list should show as current; -1 for none. */
  mark(i: number): void;
  /** Reflect a gesture-driven zoom back into the slider. */
  zoom(z: number): void;
  scopeOn: boolean;
  /** Draw the tracker's own view. Cheap no-op while the scope is closed. */
  scope(face: Pt[] | null, hands: Pt[][], quad: Pt[] | null, cw: number, ch: number): void;
  recording: boolean;
  /** Start if stopped, stop if started. Safe to call from a gesture. */
  toggleRecord(): void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initUi(canvas: HTMLCanvasElement, hooks: Hooks): Ui {
  const callout = $('callout');
  const calloutName = $('calloutName');
  const dock = $('dock');
  const zoomBox = $('zoom');
  const zoomRange = $<HTMLInputElement>('zoomRange');
  const zoomValue = $('zoomValue');
  const menu = $('menu');
  const menuBtn = $<HTMLButtonElement>('menuBtn');
  const boneList = $<HTMLUListElement>('boneList');
  const scopeBox = $('scope');
  const scopeBtn = $<HTMLButtonElement>('scopeBtn');
  const scopeView = $<HTMLCanvasElement>('scopeView');
  const scopeLabel = $('scopeLabel');
  const recBtn = $<HTMLButtonElement>('record');
  const recLabel = $('recLabel');
  const save = $<HTMLAnchorElement>('save');

  const sctx = scopeView.getContext('2d')!;
  let buttons: HTMLButtonElement[] = [];

  const ui: Ui = {
    scopeOn: false,
    recording: false,
    begin() {
      dock.hidden = false;
      zoomBox.hidden = false;
    },
    listBones(names, colours) {
      boneList.replaceChildren();
      buttons = names.map((name, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = colours[i] ?? '#fff';
        b.append(swatch, document.createTextNode(name));
        b.addEventListener('click', () => {
          hooks.pick(i);
          setMenu(false);
        });
        li.append(b);
        boneList.append(li);
        return b;
      });
      if (!names.length) {
        const li = document.createElement('li');
        li.className = 'none';
        li.textContent = 'No model loaded — the bone layer is drawing a radiograph.';
        boneList.append(li);
      }
    },
    label(name, at, cw, ch) {
      if (!name || !at) {
        callout.hidden = true;
        return;
      }
      const fit = coverFit(cw, ch, window.innerWidth, window.innerHeight);
      const p = onScreen(at, cw, fit);
      // The leader runs up and to the right; near that edge there is no room
      // for the label, so the whole thing mirrors rather than overflowing.
      callout.classList.toggle('flip', p.x > window.innerWidth - 210);
      if (calloutName.textContent !== name) calloutName.textContent = name;
      callout.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      callout.hidden = false;
    },
    mark(i) {
      buttons.forEach((b, k) =>
        k === i ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')
      );
    },
    zoom(z) {
      const v = String(Math.round(toSlider(z)));
      if (zoomRange.value !== v) zoomRange.value = v;
      showZoom(z);
    },
    scope(face, hands, quad, cw, ch) {
      if (!ui.scopeOn) return;
      drawScope(face, hands, quad, cw, ch);
    },
    toggleRecord() {
      ui.recording ? stop() : start();
    }
  };

  // ------------------------------------------------------------- zoom ---
  /*
   * The slider travels in octaves, not in percent. Zoom is a ratio: half size
   * and double size are the same distance from life size, and a linear track
   * over the same range buries 1x a fifth of the way up and spends four
   * fifths of the travel on magnification nobody asked for.
   */
  const Z_MIN = 0.35;
  const Z_MAX = 4;
  const SPAN = Math.log(Z_MAX / Z_MIN);
  const toZoom = (v: number) => Z_MIN * Math.exp((SPAN * v) / 100);
  const toSlider = (z: number) => (Math.log(z / Z_MIN) / SPAN) * 100;

  const showZoom = (z: number) => {
    zoomValue.textContent = `${z < 1 ? z.toFixed(2) : z.toFixed(1)}×`;
  };
  zoomRange.addEventListener('input', () => {
    const z = toZoom(Number(zoomRange.value));
    showZoom(z);
    hooks.zoom(z);
  });
  showZoom(1);

  // ------------------------------------------------------------- menu ---
  const setMenu = (open: boolean) => {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.addEventListener('click', () => setMenu(menu.hidden));
  $('menuClose').addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenu(false);
  });

  // ------------------------------------------------------------ scope ---
  scopeBtn.addEventListener('click', () => {
    ui.scopeOn = !ui.scopeOn;
    scopeBox.hidden = !ui.scopeOn;
    scopeBtn.setAttribute('aria-pressed', String(ui.scopeOn));
  });

  /**
   * What the tracker sees, with nothing drawn on top of it: the face mesh as
   * wire, the hands as their skeleton, and the frame's four anchors as rings.
   * Mirrored to match the main canvas, so a point that looks left here is
   * left there too.
   */
  function drawScope(face: Pt[] | null, hands: Pt[][], quad: Pt[] | null, cw: number, ch: number) {
    const { width: w, height: h } = scopeView;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, w, h);
    const fit = coverFit(cw, ch, w, h);
    sctx.setTransform(-fit.scale, 0, 0, fit.scale, w - fit.x, fit.y);
    sctx.lineWidth = 1 / fit.scale;

    if (face && face.length >= 468) {
      sctx.strokeStyle = 'rgba(111,217,242,0.5)';
      sctx.beginPath();
      for (const { start, end } of FaceLandmarker.FACE_LANDMARKS_TESSELATION) {
        sctx.moveTo(face[start].x, face[start].y);
        sctx.lineTo(face[end].x, face[end].y);
      }
      sctx.stroke();
    }

    sctx.strokeStyle = 'rgba(247,250,255,0.85)';
    sctx.lineWidth = 2 / fit.scale;
    for (const hand of hands) {
      if (hand.length < 21) continue;
      sctx.beginPath();
      for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
        sctx.moveTo(hand[start].x, hand[start].y);
        sctx.lineTo(hand[end].x, hand[end].y);
      }
      sctx.stroke();
    }

    if (quad) {
      const r = 7 / fit.scale;
      sctx.strokeStyle = '#6fd9f2';
      sctx.lineWidth = 2 / fit.scale;
      sctx.beginPath();
      quad.forEach((p, i) => (i ? sctx.lineTo(p.x, p.y) : sctx.moveTo(p.x, p.y)));
      sctx.closePath();
      sctx.stroke();
      for (const p of quad) {
        sctx.beginPath();
        sctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        sctx.stroke();
      }
    }

    sctx.setTransform(1, 0, 0, 1, 0, 0);
    const n = hands.length;
    scopeLabel.textContent = `${face ? 478 : 0} pts · ${n} hand${n === 1 ? '' : 's'}`;
  }

  // ----------------------------------------------------------- record ---
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];

  function start() {
    if (ui.recording) return;
    // webm is what Chrome on Android actually writes; the codec list is tried
    // in order so a browser missing one still gets a recorder.
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
      (t) => MediaRecorder.isTypeSupported?.(t)
    );
    if (!type) {
      recLabel.textContent = 'No recorder';
      recBtn.disabled = true;
      return;
    }
    try {
      rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type });
    } catch {
      recLabel.textContent = 'No recorder';
      recBtn.disabled = true;
      return;
    }
    chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      save.href = url;
      save.download = `ar-visor-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
      save.click();
      // Revoked on the next turn, once the click has been handled.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      chunks = [];
    };
    rec.start();
    ui.recording = true;
    recBtn.setAttribute('aria-pressed', 'true');
    recLabel.textContent = 'Stop';
  }

  function stop() {
    if (!ui.recording) return;
    rec?.stop();
    rec = null;
    ui.recording = false;
    recBtn.setAttribute('aria-pressed', 'false');
    recLabel.textContent = 'Record';
  }

  recBtn.addEventListener('click', () => ui.toggleRecord());

  // ------------------------------------------ full screen · install ---
  /*
   * Both are the platform's own: the Fullscreen API for the tab, and a
   * manifest plus `beforeinstallprompt` for the home screen. Nothing is
   * cached offline — the models and the wasm come from a CDN — so an
   * installed copy is a launcher that starts without browser chrome, not an
   * app that runs without a network.
   */
  const fullBtn = $<HTMLButtonElement>('full');
  const fullLabel = $('fullLabel');
  const installBtn = $<HTMLButtonElement>('install');

  // An installed window is already fullscreen by manifest, so neither button
  // appears there: one would have nothing to do and the other nothing to add.
  // Read once, at startup, rather than watched: browsers disagree about
  // whether `display-mode: fullscreen` also matches the Fullscreen API, and
  // one that says yes would hide the button the moment it was used — taking
  // the way back out with it. Before any call of ours, a match can only mean
  // the app was launched installed.
  const installed = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  fullBtn.hidden = installed || typeof document.documentElement.requestFullscreen !== 'function';

  fullBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      // Refused — no gesture credit left, or the platform will not. The
      // button keeps working; there is nothing to report.
    }
  });
  // The state belongs to the document, not the button: Escape and the system
  // back gesture both leave fullscreen without passing through the click.
  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement !== null;
    fullBtn.setAttribute('aria-pressed', String(on));
    fullLabel.textContent = on ? 'Exit' : 'Full screen';
  });

  // Held rather than fired: the browser offers the prompt at its own moment,
  // which is usually before there is anything on screen worth installing.
  let install: (Event & { prompt(): Promise<unknown> }) | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    install = e as Event & { prompt(): Promise<unknown> };
    installBtn.hidden = installed;
  });
  installBtn.addEventListener('click', async () => {
    const p = install;
    if (!p) return;
    // A prompt is single-use, spent whichever way the answer goes.
    install = null;
    installBtn.hidden = true;
    await p.prompt();
  });
  window.addEventListener('appinstalled', () => {
    install = null;
    installBtn.hidden = true;
  });

  return ui;
}
