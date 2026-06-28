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

**District shading** ("Color the districts by" dropdown) — pick one at a time:

- **Priority for next week** (the default) — the redder a district, the more it's
  a high-turnout area the team has *under*-canvassed. These are your best targets.
- **Our race — Bores vs Lasher** — who won each election district (green = Bores,
  gold = Lasher); stronger color = bigger margin.
- **2025 Mayor — Mamdani vs Cuomo** — who led each district in the mayoral primary.
- **2025 Dem turnout** — how many people voted in each district.
- **Canvassing coverage so far** — where the team has already spent its time.

**Map layers** ("Show on the map" checkboxes) — turn these on/off independently:

- **Canvassing sites** (on by default) — the dots.
- **Election-district lines** — the ED boundaries as outlines.
- **Neighborhoods** — labeled neighborhood areas for orientation.
- **Subway stations** — nearby stations with their train lines.

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

## The data files (in `data/`)

| file                           | what it is                                                       | where it came from |
| ------------------------------ | --------------------------------------------------------------- | ------------------ |
| `locations.json`               | every canvassed site: coordinates, dates, volunteers            | our scheduling tooling |
| `summary.json`                 | the headline totals shown at the top of the sidebar             | our scheduling tooling |
| `districts.geojson`            | election-district shapes + 2025 turnout, mayoral results, coverage | our scheduling tooling |
| `bores_lasher_results.geojson` | Bores vs Lasher vote totals by election district (NY-12 Dem primary, 6/23/2026) | [Atlasizer](https://www.atlasizer.com) (Data Mapper by Competitive Advantage Research) |
| `neighborhoods.geojson`        | Manhattan neighborhood boundaries                               | NYC Open Data — 2020 Neighborhood Tabulation Areas |
| `subway_stations.geojson`      | subway stations + train lines                                   | NYC Open Data (via `kevin-brown/nyc-open-geojson`) |

To refresh the map with newer numbers, replace the relevant file(s) with updated
exports, keeping the same names and format.

> **Note on neighborhoods:** the NYT's "extremely detailed" neighborhood map uses
> the Times' own proprietary boundaries, which aren't downloadable. This uses NYC's
> official public neighborhood boundaries instead, which are very similar.

## Privacy note

The data includes volunteer names, so keep this project **private**. It is not
meant to be published publicly.

## What's inside

- `index.html` — the page
- `style.css` — the styling
- `app.js` — the map logic (plain JavaScript + [Leaflet](https://leafletjs.com))
- `start_map.command` — double-click launcher
- `data/` — the canvassing location data
