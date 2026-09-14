# AR Visor

Client-side AR: MediaPipe face + hand landmarks over a mirrored 640x480 webcam feed on a canvas.
Framing your face with both hands and bringing them together cycles the overlay skin.

## Dev

```bash
npm install
npm run dev     # then open the printed LAN URL on the tablet
npm test        # gesture state-machine check
```

The camera needs a secure context: `localhost` works, a plain LAN IP does not.
On Android Chrome, add the dev URL under `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
or just use the deployed Pages URL (HTTPS).

## Deploy (GitHub Pages)

1. Repo name must match `base` in `vite.config.ts` (currently `/ar-visor/`).
2. Push to `main`.
3. Settings → Pages → Source: **GitHub Actions**.

Live at `https://<user>.github.io/ar-visor/`.

## Swapping in your PNGs

Drop files in `public/assets/`, then in `src/main.ts` replace the marked
`ctx.arc` / `ctx.roundRect` blocks with `ctx.drawImage(...)` using the same
rect arguments. Load images with `import url from '/assets/tobi.png'`-style
paths respecting `import.meta.env.BASE_URL`.
