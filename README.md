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
| **point at a bone** | names it |
| **keep pointing at it** | lifts that bone out on its own |
| **pinch with both hands** | zoom, by pulling them apart or together |
| **clap** | one step back |

**One hand points, two hands pinch, and nothing does both.** Counting pinched
hands was the wrong split: a two-handed pinch passes through a one-handed one
at each end of itself, so every zoom named a bone on the way in and named
another on the way out. Shape cannot overlap the way a count does. A point
wants the thumb clear of the index and a pinch wants it against, so no hand
satisfies both and none gets from one to the other without the gap they are
measured on crossing the middle. The band between the two thresholds is where
neither fires — something to pass through, not to land in.

Naming and lifting a bone out are then the same gesture held longer: point to
read the name, keep pointing at the same bone and it comes out on its own.
Nothing extra to learn, and the old held-still-versus-zoom arbitration goes
with it. A zoom still picks up where the last one left off rather than snapping
back to life size each time you re-grab.

## One bone on its own

Lifting a bone out gives it the screen to itself, sized to its own extents
rather than the skull's. Both pinches still zoom. **Point and move to turn
it** — a drag across the screen is a full revolution, and the canvas is
mirrored, so the landmark delta is negated to put the turn the way round the
hand expects.

The head stops driving it here. It is an object being turned by hand, so it
keeps drawing whether or not a face is still in shot — which is the point of
having taken it out of the skull in the first place. Every renderer already
guards on landmark count, so a frame with no face is simply nothing to pose
against.

A clap steps back one level rather than all the way out: a single bone returns
to the skull it came from, and the skull returns to the hand-held frame.

The point casts a ray into the scene at the index fingertip. Landmarks and the
3D are both in unmirrored video space — the mirror is applied once, to the
blit — so the point needs no flipping before it is cast. Pointing at nothing
clears the label rather than leaving a stale reading on screen.

Bone names come off `userData`, not `Object3D.name`: GLTFLoader runs node
names through `sanitizeNodeName`, which turns spaces into underscores and
deletes dots, so `Parietal bone.l` arrives as `Parietal_bonel` — and by then
the side is an ordinary letter at the end of a word.

## The chrome

The camera is the page; everything else floats over it in glass. That is not
decoration — the controls sit on moving video and have to stay legible against
a sunlit window one second and a dark room the next, so each panel carries its
own opaque floor under the blur rather than letting the feed set the contrast,
and the blur is paired with saturation, which is what pulls colour up out of
the picture behind and makes the surface read as a material. Measured against
mid-grey video: 10.6:1 for the primary text, 7.5:1 for the secondary.

**The bone label is an atlas leader, not a speech bubble.** An arrow touches
the bone and the label stands off it, so the thing being named is never
underneath the thing naming it. It follows the bone rather than the fingertips
that named it, which keeps it attached while the view turns; near the right
edge the whole leader mirrors rather than letting the label overflow. Getting
it there means crossing from canvas pixels to CSS pixels, through both the
mirror and the `object-fit: cover` crop — `coverFit` and `onScreen` do that,
and they are checked, because a label that drifts is very hard to debug by eye.

**The bone list** is the way in for anyone who cannot hold both hands up, and
the only way to reach a bone buried too deep in the skull to pinch. Each row
carries the bone's own colour, read off the model's material rather than
assigned here.

**The zoom slider travels in octaves.** Zoom is a ratio: half size and double
size are the same distance from life size. A linear track over the same range
buries 1x a fifth of the way up and spends four fifths of its travel on
magnification nobody asked for. The slider and the two-hand pinch drive the
same number, so moving either moves the other.

**The scope** is the tracker's own view — wireframe, hand skeletons, and the
frame's four anchors, with nothing drawn on top. It is the quickest way to see
whether a gesture failed because the pose was wrong or because tracking lost
the hand.

**Full screen and install** are both the platform's own: the Fullscreen API
for the tab, and a manifest for the home screen. Neither button shows in an
installed window — it already launches without browser chrome — and that is
decided once at startup rather than watched, because browsers disagree about
whether `display-mode: fullscreen` also matches a page that called
`requestFullscreen`, and one that says yes would hide the button the moment it
was used, taking the way back out with it. The fullscreen label follows the
document rather than the button, since Escape and the system back gesture also
leave.

Nothing is cached offline. The landmark models and the wasm come from a CDN, so
an installed copy is a launcher that starts without an address bar, not an app
that runs without a network — which is why there is no service worker here.
The manifest is checked by `npm test`: a wrong icon path or a mis-declared size
costs the install prompt silently, with the page working perfectly in every
other way.

**Recording** writes webm from `canvas.captureStream`, so it captures what the
canvas shows rather than the raw camera. A fast double blink is the shutter,
counted on the eye reopening rather than closing — that is the edge that means
a blink completed, and it keeps a long thoughtful close from reading as half a
pair. The hands are usually busy holding the thing worth recording.

## Dev

```bash
npm install
npm run dev     # then open the printed LAN URL on the tablet
npm test        # gesture + palette + pose + study + zoom + manifest checks
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
iterate, but nothing to set up. From there the dock's **Install** button puts
it on the home screen, where it launches fullscreen with no address bar; the
button only appears once the browser says the page qualifies.

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
