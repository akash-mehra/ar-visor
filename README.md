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
is exempt: it is the bare camera, so there is nothing to read against. Bone
replaces the face outright either way, so the mode does not reach it — and it
always lays its own black down regardless, because a colour-coded skull over a
lit room is mostly room. That black deepens once the frame is the whole
screen, where there is nothing behind it worth keeping.

The anatomy palette is three layers deep. How many fingers you
hold up picks one:

| fingers | pose | layer |
|---|---|---|
| 5 | whole hand | skin — bare camera |
| 4–3 | thumb, index, middle | muscle |
| 2–0 | thumb and index, down to a fist | bone — the 3D skull |

The counts are grouped rather than spread evenly: an open hand and a fist are
the two poses nobody fumbles, and the ones between them are where the detector
has to guess.

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

## The bone layer

Bone is not drawn from landmarks at all. It is a real skull —
`public/assets/skull.glb` — rendered with three.js and posed to the head. It
draws to its own WebGL canvas and is blitted into the same 2D context as
everything else, so there is still one clipping path, one mirror and one wipe
for every layer.

The pose comes from four landmarks rather than MediaPipe's head-pose matrix:
234 and 454 at the temples, 10 at the forehead and 152 at the chin, all on
bone so expression does not move them. The matrix would be fewer lines, but a
transposed rotation is its own inverse — the head would turn the wrong way and
the code would still look right — and four landmarks can be checked against
numbers instead of against a tablet.

Each bone's direction out of the skull comes from its own geometry, so the
file needs no authored explode hints and bones added to it later need no code
change.

Separating the bones is also what carries the skull off the face, and the same
value drives both: at rest it is sized to the temples and sits where the head
is, fully apart it is centred and sized to the screen, and everything between
is the blend. A view of a skull in pieces is not a view of a face, and scaling
one to the other only means standing closer throws the far bones off the edge.
Being centred is also what holds a bone still long enough to be pinched.

How much room it needs is measured from where the bones actually end up rather
than from a sphere around the model — they do not all travel the same distance,
and fitting the bounding diagonal leaves the view about a third smaller than
the screen allows. Across all three axes, not just the two on screen, because
the head turns and its depth swings into view with it. Reading it off the
geometry also means a re-exported model resizes itself.

The model is Draco-compressed, and the decoder is served from `public/draco/`
rather than a CDN. That copy looks redundant — `DRACOLoader` already defaults
to a module-level `new URL('../libs/draco/…', import.meta.url)` that the
bundler resolves and emits from our own origin — but that default only
survives a production build. Under the dev server `import.meta.url` points
into vite's pre-bundle directory, the relative path resolves to nothing, and
the 404 comes back as `index.html`, which the decoder then tries to run. The
copy in `public/` resolves the same way in both. A model that fails to load is
not an error — the bone layer falls back to drawing a radiograph.

## Study mode

**Carry the frame off the sides of the screen and the skull comes apart.** On
the bone layer, take both hands out through the left and right edges still
holding the frame. Leaving through the top or bottom does nothing — neither
wrist was near a lateral edge. Tracking rarely ends tidily, one hand usually
being lost a frame or two before the other, so each side is remembered with a
time of its own and the trigger is both sides having gone recently with
nothing left on screen.

What that leaves is a different way to hold the app. The frame fills the
display and stops moving, the bones separate, and the finger count is not read
at all — so a hand reaching back in to point at something cannot change the
layer out from under it. Two gestures still work:

| gesture | |
|---|---|
| **one pinch** | names the bone under your fingertips |
| **two pinches** | zoom, by pulling them apart or together |
| **two pinches, held still on one bone** | lifts that bone out on its own |
| **clap** | one step back |

How many hands are pinching is what keeps these out of each other's way: two
pinched hands can only be a zoom or a grab, one can only be a question, and a
clap needs both hands open — so pulling the zoom shut cannot slam the door on
the way out. A zoom picks up where the last one left off rather than snapping
back to life size each time you re-grab.

Holding is what tells a grab from a zoom. A zoom changes the distance between
the two pinches by definition, so a distance that has not moved for half a
second is not one. Both run at once and cost nothing for it, because a zoom
that holds still does not zoom.

## One bone on its own

Lifting a bone out gives it the screen to itself, sized to its own extents
rather than the skull's. Two pinches still zoom. **One pinch grabs it and
turns it** — a drag across the screen is a full revolution, and the canvas is
mirrored, so the landmark delta is negated to put the turn the way round the
hand expects.

The head stops driving it here. It is an object being turned by hand, so it
keeps drawing whether or not a face is still in shot — which is the point of
having taken it out of the skull in the first place. Every renderer already
guards on landmark count, so a frame with no face is simply nothing to pose
against.

A clap steps back one level rather than all the way out: a single bone returns
to the skull it came from, and the skull returns to the hand-held frame.

The pinch casts a ray into the scene at the point between thumb and index.
Landmarks and the 3D are both in unmirrored video space — the mirror is
applied once, to the blit — so the pinch point needs no flipping before it is
cast. A pinch that catches nothing clears the label rather than leaving a
stale reading on screen.

Bone names come off `userData`, not `Object3D.name`: GLTFLoader runs node
names through `sanitizeNodeName`, which turns spaces into underscores and
deletes dots, so `Parietal bone.l` arrives as `Parietal_bonel` — and by then
the side is an ordinary letter at the end of a word.

## Dev

```bash
npm install
npm run dev     # then open the printed LAN URL on the tablet
npm test        # gesture + palette + pose + study + zoom checks
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
