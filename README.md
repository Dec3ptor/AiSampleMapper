# Stockpile Sample Mapper

A browser tool for planning and counting contaminated-land sampling of stockpiles
on an aerial photo. Outline each pile, get its footprint area and volume, let the
density rule tell you how many locations it needs, place them, and export the
schedule, the GIS layers and a report figure.

Everything runs in the browser. The aerial image never leaves the machine.

**Live: <https://dec3ptor.github.io/AiSampleMapper/>** — deployed from this branch
by `.github/workflows/pages.yml` on every push.

## Running it

Open `index.html` — double-click it, or serve the folder:

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

No build step, no dependencies. The scripts are plain `<script>` tags so the
`file://` path works too, which matters when you are on site without a network.

## The workflow

1. **Load the aerial image.** Drag it onto the map, or use *Aerial image*. JPG,
   PNG or WebP.
2. **Set the scale.** Nothing is measured until this is right. Three ways:
   - **Metres per pixel** typed straight in. The *0.10 m — BOPRC 2026* button
     matches the Bay of Plenty post-weather-event survey (see below).
   - **Measure a known length** — click the two ends of something you can
     measure and enter its length. Use this to check any assumed scale.
   - **World file** (`.jgw` / `.pgw` / `.tfw`) for exact georeferencing
     including rotation. It must match the image at its original pixel size; a
     resized crop will not line up.

   To get real NZTM coordinates out, also **pin a known coordinate**: read a
   recognisable feature's easting and northing off your GIS, type them in, and
   click that feature on the photo. Assumes the image is north-up.
3. **Outline the stockpiles.** Stockpile tool, click around the pile, `Enter` or
   click the first point to close.
4. **Give each pile a mean height and a form.** Volume is
   `footprint area × mean height × form factor`, because a pile is rarely a
   prism — flat-topped 0.70, domed 0.50, conical 0.33, level/bunded 1.00, or your
   own. You can override the volume outright if you have survey figures.
5. **Place sample locations.** Click them in with the Sample tool, or use
   *Place n locations* for a systematic grid, stratified random or simple random
   spread, kept clear of the toe of the pile.
6. **Export.**

## Image resolution

The photo is used at full resolution, whatever its size:

- Dropped files are decoded with `createImageBitmap`, which is not subsampled by
  the browser the way a plain `<img>` is on very large images — the usual cause
  of a full ortho tile quietly losing detail on iOS.
- The canvas renders at the display's real pixel density (up to 3x), bounded so
  the backing store stays under about 16 megapixels.
- Each frame blits only the source pixels that can land on screen, so zooming
  into a 35 megapixel tile costs the same as a small one and nothing is
  resampled on the way.
- Above 1:1 the real ortho pixels are shown rather than a smoothed guess. Switch
  to **Smoothed** under *Setup → Aerial image* if you prefer interpolation.
  Zooming out always uses a high-quality downsample.
- Zoom runs to 240x. **1:1** in the corner of the map snaps to one photo pixel
  per screen pixel.

At 10 cm GSD, 1:1 is one pixel per 10 cm of ground, and the status bar shows the
ground size of a screen pixel at any zoom. Zooming past 1:1 magnifies but adds no
detail — the example site ships as a 750 x 2000 clipping, so load your own tile
to see what the imagery really holds.

## Naming

Set the convention once under **Plan → Naming** and it applies as you draw.

**Numbering order** decides which thing gets number 1. It applies to both
renumbering stockpiles and the automatic sample IDs:

| Setting | Order |
| --- | --- |
| Top to bottom | Down the photo — north to south when the photo is north-up (default) |
| Left to right | Across the photo — west to east |
| The order I drew them | Draw order, with no reference to position at all |

Pick the last one to switch position-based numbering off. It is the one to use
when you place things in a deliberate sequence, or when the photo is not
north-up so "down the page" does not mean north to south.

**Stockpiles and windrows** take a prefix, a digit count and a starting number —
`WR` + 2 digits gives `WR01`, `WR02`, `WR03`. A preview shows the result as you
type. Every new outline takes the next free number on its own, so drawing a run
of windrows numbers itself. **Renumber** re-applies the convention in whichever order
is set above, which is usually what you want after adding or deleting a few.

**Sample locations** work the same way, either numbered across the whole site
(`SP01`, `SP02`) or within each pile (`WR01-01`, `WR01-02`), which is the more
useful form once a pile has its own name. Site-wide numbering is one run across
the whole job: whether a sample happens to sit inside a stockpile outline makes
no difference to its number. Sample IDs re-flow whenever the plan
changes, so the numbering order matters most here.

**A composite takes one number**, like any other sample, so the singles after it
carry straight on — `SP01`, `SP02` (composite ×5), `SP03`, `SP04` (composite ×3),
`SP05`. One ID per laboratory sample, whatever it was built from.

**QA samples take no number of their own.** A field duplicate is a second jar
from the same spot rather than another location, so it takes the ID of the
sample it checks with a suffix: `SP03D`, and a second one `SP03D2`; an inter-lab
split is `SP05S`. Nothing after it shifts — numbering one would renumber the rest
of the job every time you added a duplicate. If its primary is later deleted the
orphan falls back to a number of its own so it still has a unique ID.

Anything you type yourself is pinned: renumbering leaves it alone, reports how
many it kept, and routes around its number so two features can never share a
name. A pinned sample ID shows a dot in the list, and the sample editor offers to
hand it back to automatic numbering.

To rename one thing: click it in the list or on the map and edit the **Name** or
**ID** box, use the pencil on any list row, press <kbd>F2</kbd>, or double-click
it on the map.

## Field mode

**Field** in the top bar swaps the planning panels for a collection screen:
big targets, a running count, and an arrow to the next sample.

**Progress and pace.** A bar across the top shows done / total, how many are
left, and a rate in samples per hour worked out from the times you actually
ticked them off. From that it gives time remaining and a finish clock; the rate
appears once two are done.

Two things would otherwise wreck that number, so neither counts: **long breaks**
— overnight, lunch, driving between sites — are not working time, so completions
are cut into stints at any gap over 90 minutes and only the current stint counts;
and within a stint a rolling window of the last six tracks the pace you are
working at *now* rather than a slow start finding the site. Leave it overnight
and the rate shows *paused* until the next sample goes in, instead of averaging
your day across sixteen hours.

**Getting to the point.** The arrow in the corner card points at the sample
you're walking to, with the distance and the ID. Tap **Compass** once and the
arrow points relative to the way you're facing; without it, it points relative
to north. Tap any marker on the map to walk to that one instead, or **Next** to
take the closest outstanding one.

**Your position** is the blue dot, drawn with the accuracy circle the phone
reports. Worth being honest about: a phone GPS is good to roughly 3–10 m, while
the orthophoto behind it is good to about 0.27 m. The arrow gets you to the
right stockpile, not to the right shovel-width — which is why the accuracy
circle is drawn at its real size rather than hidden.

**Changing the plan on site:**

| Button | What it does |
| --- | --- |
| Collected | Marks it done and stamps the time the rate is built from |
| Un-collect | Tap a finished marker and the same button puts it back, clearing its timestamp so it stops counting toward the rate |
| No access | Marks it skipped and records why. Tapping a skipped one offers **Reinstate** |
| Move here | Moves the sample to where you're standing, recording the GPS accuracy |
| Add here | Drops a new sample at your position |

**Move here** is the one that matters most: when the marked spot turns out to be
under a truck, you sample nearby and the plan records where you *actually* went,
with the fix accuracy alongside it.

### Offline and installing it

The site registers a service worker, so once loaded it works with no coverage —
which is the normal state of a stockpile site. Code and markup are fetched
network-first, so online you always run the current deploy and the cache is only
reached for when there is no signal; photos and icons are cache-first since they
do not change. The build stamp at the bottom of **Setup** says which version you
are on. On iOS open it in Safari and use
Share → **Add to Home Screen**; on Android, Chrome's **Install app**. It then
runs full-screen with no browser chrome, and keeps the screen awake while you're
in field mode.

Two requirements: GPS needs **HTTPS**, which the GitHub Pages link is, and the
image must be **georeferenced** (see Scale & georeference) or there is nothing to
tie your position to. Everything else — progress, rate, marking off — works
without GPS.

## Composite samples

A composite is one laboratory sample, with one ID, built from material taken at
several spots. The app keeps that distinction: many increment locations on the
photo, one name everywhere else.

Set a sample's type to **Composite**, then **Mark increments on the map** and
click each spot you will take material from. The marker moves to the centre of
its increments and carries a `×5` on its label; the increments draw as small
dots tied back to it. Dragging the marker moves the whole cluster; dragging one
increment moves just that one.

To do a whole pile at once, use the pile editor's **Composite** option and set
the increments per composite. The pile is split into sections along its longest
axis and one composite is built per section, so a result can still be traced to
part of the pile — interleaving the increments instead would make every
composite cover the whole pile, which is *n* replicates of one answer rather
than *n* samples.

What comes out:

| Export | A composite appears as |
| --- | --- |
| Sample schedule (CSV) | One row, one ID, `Increments` filled in, positioned at the centre |
| Increment locations (CSV) | One row per spot — `SP01, 1, of 5`, with coordinates |
| GeoJSON | One feature with a `MultiPoint` geometry |
| KML | One placemark with a `MultiGeometry` |

The plan summary counts a composite as **one** laboratory sample and also shows
the **spots to visit**, which is what the field day actually costs.

## Sampling density

The rule is yours to set, under **Plan**:

- **Per volume** — one location per *n* m³, with a minimum per pile.
- **Banded** — a volume lookup table, plus a rate above the top band.
- **Fixed** — the same count for every pile.

The shipped defaults (1 per 250 m³, minimum 3; and the banded table) are a
starting point, not an authority. Set them from whatever governs your job — the
receiving facility's waste acceptance criteria, the consent conditions, or the
applicable guidance such as MfE *Contaminated Land Management Guidelines No. 5*
or the WasteMINZ *Technical Guidelines for Disposal to Land*. Whatever you
choose is printed on every export so the basis travels with the numbers.

**QA/QC** is counted separately: field duplicates are co-located with a primary
sample, so they add laboratory samples but not locations. Defaults are one
duplicate per 20 primary samples, no inter-lab splits, no blanks.

## Printing

**Export → Print / PDF** lays the plan onto paper. Choose **Save as PDF** as the
destination in the print dialogue, or send it to a printer.

| Setting | |
| --- | --- |
| Paper | A4 or A3 |
| Orientation | Auto, landscape or portrait. Auto tries both and keeps whichever fills more of the sheet — a tall site on a landscape page wastes half the paper |
| Scale | Fit the whole plan to one sheet, or hold a real 1:1000 / 1:500 / 1:250 / 1:100 and let it run across as many sheets as that needs |
| Sheet index | An overview sheet with the sheets numbered on it, when it splits |
| Sample schedule | A table of every location with a tick column to sign off in the field |

The readout tells you what you are about to get — *"2 × 3 = 6 sheets at 1:250,
A3 landscape"* — before you commit any paper to it. Split sheets overlap
slightly so nothing is lost in a join, and every sheet carries the title block,
legend, scale bar and north arrow.

It goes through the browser's own print dialogue rather than bundling a PDF
library: no network needed, and the title block prints as real text at printer
resolution instead of being flattened into an image. Turn the dialogue's margins
off — each sheet already carries its own.

## Exports

| Output | What it is |
| --- | --- |
| Sample schedule (CSV) | One row per location: ID, pile, type, depth, status, NZTM easting/northing, latitude/longitude, image pixel |
| Stockpile register (CSV) | Area, height, form factor, volume, required vs planned, shortfall |
| GeoJSON | Points and outlines for QGIS or ArcGIS, in WGS84 when georeferenced |
| KML | Waypoints for a handheld GPS or Google Earth (needs real coordinates) |
| Report figure (PNG) | The map with a title block, legend, scale bar and north arrow |
| Project (JSON) | The whole plan, to reopen or hand over |

Every text export also has a **Copy** button, for when a download is blocked.

Coordinates are converted between NZTM2000 and latitude/longitude with the
Redfearn transverse Mercator series on GRS80. That implementation is
cross-checked against an independently formulated Krüger *n*-series over the
whole NZTM zone and agrees to about 1 mm — four orders below the 0.268 m (95%)
positional accuracy of the source imagery.

## Keyboard

| Key | Action |
| --- | --- |
| `V` `P` `S` `M` `X` | Select, Stockpile, Sample, Measure, Erase |
| `F` | Zoom to fit |
| `F2` | Rename the selected stockpile or location |
| `Enter` | Close the outline being drawn |
| `Esc` | Cancel the outline, measurement or pending click |
| `Backspace` | Remove the last vertex, or delete the selection |
| `Ctrl`/`Cmd` `Z` | Undo (`Shift` to redo) |
| `Ctrl`/`Cmd` `S` | Save the project file |
| Drag, scroll | Pan, zoom. `Alt` or `Shift` drag pans with any tool |

Field mode is touch-first and has no shortcuts; everything is a button.

## The example site

The app opens on an example: a clipping of Bay of Plenty Regional Council
post-weather-event aerial imagery, with one stockpile outlined and sampled to
show the flow. Drop your own image on it to start work; the example is cleared.

`docs/PRJ50634_01_imagery_metadata.pdf` is the survey report for that imagery
(Woolpert, PRJ50634_01, captured 15–31 March 2026). The parts that matter here:

- **10 cm GSD**, which is where the 0.10 m/pixel default comes from
- **NZGD2000 / NZTM2000**, which is the CRS the coordinate exports assume
- Reported ortho accuracy **RMSE 0.136 m, 0.268 m at 95% confidence**, against a
  project requirement of 0.5 m — so a location read off this imagery is good to
  roughly a quarter of a metre, before any error in your own digitising

That accuracy is worth keeping in mind: it is fine for finding a pile again, and
too coarse to defend a boundary to the centimetre.

## Storage

The plan autosaves to this browser's `localStorage` and the image to
IndexedDB, so a reload picks up where you left off. That is a convenience, not a
backup — it is per-browser, per-machine, and cleared site data takes it with it.
Save the project file for anything you need to keep.

## Layout

```
.github/workflows/pages.yml  deploys the site to GitHub Pages on push
index.html                 page shell (a complete document; opens from disk)
css/app.css                tokens, app shell, light and dark themes
js/geo.js                  NZTM2000 <-> WGS84, world files, the georef model
js/geometry.js             polygon measurement, sample location generation
js/plan.js                 volumes, density rules, QA/QC requirements
js/store.js                project state, ids, undo, persistence
js/render.js               canvas drawing, shared by the map and the figure
js/export.js               CSV, GeoJSON, KML, PNG figure, project file
js/field.js                on-site mode: GPS, progress, rate, field edits
js/print.js                paper layout: sheet splitting, title block, schedule
js/app.js                  interaction, panels, wiring
sw.js                      offline shell, so the site works with no coverage
manifest.webmanifest       makes it installable to a home screen
tools/build-artifact.mjs   emits artifact.html for publishing as a Claude Artifact
sample/site-aerial.jpg     the example aerial clipping
docs/                      imagery survey report
```

`artifact.html` is generated — run `node tools/build-artifact.mjs` after changing
`index.html`, never edit it by hand.
