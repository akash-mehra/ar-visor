# AR Visor

Client-side AR: MediaPipe face + hand landmarks over a mirrored 640x480 webcam feed on a canvas.
How many fingers you hold up picks the overlay layer — open hand for the first,
closed fist for the last. A count has to be held for a few frames before it
takes effect, so folding from five to one skips straight past the layers between.

The only palette so far is `anatomy`: skin (bare camera), muscle, bone. It is
drawn procedurally from the landmarks, so it needs no art.

## Dev

```bash
npm install
npm run dev     # then open the printed LAN URL on the tablet
npm test        # gesture + palette checks
```

The camera needs a secure context: `localhost` works, a plain LAN IP does not.
On Android Chrome, add the dev URL under `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
or just use the deployed Pages URL (HTTPS).

## Deploy (GitHub Pages)

1. Repo name must match `base` in `vite.config.ts` (currently `/ar-visor/`).
2. Push to `main`.
3. Settings → Pages → Source: **GitHub Actions**.

Live at `https://<user>.github.io/ar-visor/`.
