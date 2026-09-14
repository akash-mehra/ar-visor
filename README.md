# AR Visor

Client-side AR: MediaPipe face + hand landmarks over a mirrored 640x480 webcam feed on a canvas.
How many fingers you hold up picks the overlay layer — open hand for the first,
closed fist for the last. A count has to be held for a few frames before it
takes effect, so folding from five to one skips straight past the layers between.

Both hands hold a frame between them, the way you frame a shot: make an "L"
with each hand and the four corners are the thumb tips and the index
fingertips. Nothing else on the hand touches the frame, so the other fingers
are free to carry the pose that picks the layer, and closing a hand narrows
the frame rather than moving it. Each corner is marked with a dot, so a
screenshot shows where the anchors landed.

Everything is drawn inside that frame and nothing outside it, so the hands
holding it stay as the camera sees them. No frame without two hands, and then
nothing is drawn at all.

A button toggles what the frame shows. **Project** keeps the camera: the room
and the person stay, and the layer is drawn onto the face with the eyes and
mouth left open so they read through it. **Displace** lays a translucent dark sheet over the room
inside the frame and covers the whole face oval, so only the layer reads. Skin
is exempt: it is the bare camera, so there is nothing to read against. The
bone layer is a radiograph either way, so it always covered the face.

The only palette so far is `anatomy`, four layers deep. How many fingers you
hold up picks one:

| fingers | pose | layer |
|---|---|---|
| 5 | whole hand | skin — bare camera |
| 3 | thumb, index, middle | subcutaneous fat |
| 2 | thumb and index | muscle |
| 0 | fist | bone, as a radiograph |

The face layers fill the tesselation's own triangles, shaded per facet from
the landmark depths, so the tissue keeps the form of the head underneath
instead of sitting on it like a sticker.

A layer can instead be painted from an anatomical still. Drop a front-facing
one at `public/assets/muscle.jpg` and the muscle layer uses it: at startup the
landmarker runs over the still once, and the still's own 468 points become the
texture coordinates, so each mesh triangle is drawn from the matching triangle
of the art. No table of coordinates to keep in step with the image, and
swapping the art needs no code change. Without the file, the layer falls back
to drawing itself.

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

Then: tap **Start camera**, grant the permission, and hold both hands up to
frame your face. The
status line at the top names the current layer, so you can see the count
committing even while the layer is `skin` and nothing is drawn. Five fingers
is `skin`, three is `muscle`, a fist is `bone`; a count has to be held for
about four frames before it takes.

The page takes a screen wake lock, so the tablet will not sleep while you have
both hands up — but switching away from the tab drops it, and you need a reload
to get it back. Capture orientation is read once at startup too, so rotating
the tablet means reloading.

If Android hands the camera to another app, the status line reads `Camera
stopped` and the start button comes back: tap it to pick up again. The models
stay loaded, so only the camera restarts.

## Deploy (GitHub Pages)

1. Repo name must match `base` in `vite.config.ts` (currently `/ar-visor/`).
2. Push to `main`.
3. Settings → Pages → Source: **GitHub Actions**.

Live at `https://<user>.github.io/ar-visor/`.
