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

## Testing on an Android tablet

`getUserMedia` needs a secure context, and a plain LAN IP is not one — so
`http://192.168.x.x:5173` will fail on the tablet however well it works on the
laptop. Two ways round it, neither needing a certificate:

**USB, with hot reload** — the dev loop. Enable Developer options → USB
debugging on the tablet, plug it in, then on the laptop open
`chrome://inspect/#devices` → **Port forwarding** and map `5173` to
`localhost:5173`. With `npm run dev` running, open `http://localhost:5173` *on
the tablet*: it counts as a secure context, so the camera works, and edits
still hot-reload.

**No cable** — push to `main` and open the Pages URL (HTTPS). Slower to
iterate, but nothing to set up.

Then: tap **Start camera**, grant the permission, and hold one hand up. The
status line at the top names the current layer, so you can see the count
committing even while the layer is `skin` and nothing is drawn. Five fingers
is `skin`, three is `muscle`, a fist is `bone`; a count has to be held for
about four frames before it takes.

The page takes a screen wake lock, so the tablet will not sleep while you have
both hands up — but switching away from the tab drops it, and you need a reload
to get it back. Capture orientation is read once at startup too, so rotating
the tablet means reloading.

## Deploy (GitHub Pages)

1. Repo name must match `base` in `vite.config.ts` (currently `/ar-visor/`).
2. Push to `main`.
3. Settings → Pages → Source: **GitHub Actions**.

Live at `https://<user>.github.io/ar-visor/`.
