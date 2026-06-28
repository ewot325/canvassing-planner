# Canvassing Planner

A small, standalone website to help the organizing director **decide where to
send canvassers next week**. It shows every place the team has canvassed on an
interactive map, highlights where the biggest opportunities are, and lets you
build a day-by-day plan for the upcoming week. It runs entirely on your own
computer — no login, no internet account, no servers to maintain.

## What you get

**A map (light mode)** of every past canvassing location. Each dot is one spot;
**bigger dots** were canvassed more. Click any dot to see its dates, person-days,
and which volunteers went.

**Election-district shading**, switchable with the "Map shading" dropdown:

- **Priority for next week** (the default) — the redder a district, the more it's
  a high-turnout area the team has *under*-canvassed. These are your best targets.
- **2025 Dem turnout** — how many people voted in each district.
- **Canvassing coverage so far** — where the team has already spent its time.

**A Locations list** you can search and sort — including "Longest since
canvassed" (great for rotating sites) and "Most worth revisiting." Each row shows
how long it's been since that spot was last canvassed.

**A "Plan the week" tab** — pick the upcoming week, click a day, then hit
**+ Add** on any location to drop it onto that day. Your plan saves automatically
(in the browser) and you can **Print / Save as PDF** or **Copy as text** to share
it with the team.

## How to open it (the easy way)

1. Open this `canvassing-locations-map` folder on your Mac (in Finder).
2. **Double-click `start_map.command`.**
   - A Terminal window opens and your web browser pops up with the map.
   - The first time, macOS may say it "cannot verify the developer." If so:
     right-click `start_map.command` → **Open** → **Open**. You only do this once.
3. When you're done, close the Terminal window to shut the map down.

That's it. Everything stays on your computer.

## How to open it (manual way, if you prefer)

Open a Terminal in this folder and run:

```bash
python3 -m http.server 8765
```

Then visit <http://localhost:8765/index.html> in your browser.

> **Why a server?** Browsers block local pages from reading data files when you
> just double-click the HTML. The little server above is what lets the map load
> its data. (Opening `index.html` directly will show an empty map.)

## Updating the data

The map reads three files in the `data/` folder:

| file                | what it is                                            |
| ------------------- | ----------------------------------------------------- |
| `locations.json`    | every canvassed site: coordinates, dates, volunteers  |
| `summary.json`      | the headline totals shown at the top of the sidebar   |
| `districts.geojson` | election-district shapes + 2025 turnout (the overlay) |

To refresh the map with newer numbers, replace these three files with updated
exports (keeping the same names and format).

## Privacy note

The data includes volunteer names, so keep this project **private**. It is not
meant to be published publicly.

## What's inside

- `index.html` — the page
- `style.css` — the styling
- `app.js` — the map logic (plain JavaScript + [Leaflet](https://leafletjs.com))
- `start_map.command` — double-click launcher
- `data/` — the canvassing location data
