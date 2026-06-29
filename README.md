# Canvassing Planner

A small, standalone website to help the organizing director **decide where to
send canvassers next week**. It shows every place the team has canvassed on an
interactive map, highlights where the biggest opportunities are, and lets you
build a day-by-day plan for the upcoming week. It runs entirely on your own
computer — no login, no internet account, no servers to maintain.

## What you get

A clean three-block layout: a **Left panel** (search + map controls), the **map**
in the center, and a **Plan the week** panel on the right.

**Search any address or place** (box at the top-left) — including named places like
"Hunter College" or "Trader Joe's," not just street addresses. Pick a result to drop
a 📍 pin on the map; you can add that spot to a shift, just like anything else.

**District shading** ("Color the districts by" dropdown) — pick one at a time:

- **Priority for next week** (the default) — the redder a district, the more it's
  a high-turnout area the team has *under*-canvassed. These are your best targets.
- **2026 Dem Primary Results** — who won each election district (green = Bores,
  gold = Lasher); stronger color = bigger margin.
- **2025 Mayor — Mamdani vs Cuomo** — who led each district in the mayoral primary.
- **2025 Dem turnout** — how many people voted in each district.
- **Canvassing coverage so far** — where the team has already spent its time.

**Click any election district** for a popup with: registered Democrats, 2026
Dem primary turnout + who won and by how much, and 2025 mayoral primary turnout
+ who led. The popup also has an **Add to shift** button for planning (below).

There's a **"?" button** at the top of the map that explains how Priority is
calculated and how to use the site.

**Map layers** ("Show on the map" checkboxes) — turn these on/off independently:

- **District lines (ED & AD)** (on by default) — thin lines = election districts,
  thick navy lines = assembly-district divisions. Stay visible under any shading and
  at every zoom level.
- **District labels (ED & AD)** — assembly-district numbers always show; election-
  district numbers appear once you zoom in.
- **Neighborhoods** — labeled neighborhood areas for orientation.
- **Subway stops** — only the stops inside the district; colored by train line
  (official MTA colors); station names appear when you zoom in.
- **Priority Election Day poll sites** — 🗳 pins, colored by partisan lean; hover
  for the neighborhood, priority, and how many bodies the site needs.
- **Early voting sites** — purple **EV** pins.
- **Supermarkets** — 🛒 pins for high-foot-traffic canvassing spots.

## Weather

The left panel shows a live **NYC weather** card (current conditions + a 5-day
forecast with rain chances, via the free Open-Meteo service).

## Planning a week (right panel)

- Every day has two shifts. **Mon–Fri:** AM 8a–12p, PM 4–8p. **Sat–Sun:** AM
  9a–1p, PM 12–4p.
- Click a **shift** to select it, then **click anything on the map** — an election
  district, a supermarket, a subway stop, or a search result — and choose
  **Add to shift** in its popup. Click it again (or the ✕ on its chip) to remove.
- Your plan saves automatically (in the browser); **Print / Save as PDF** or
  **Copy as text** to share it with the team.

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
| `subway_stations.geojson`      | current Manhattan subway stations + train lines                 | MTA Subway Stations (data.ny.gov `39hk-dx4f`) |
| `election_day_poll_sites.geojson` | priority Election Day poll sites + lean/priority/bodies        | campaign list (`NY12 Priority Pollsites…csv`), geocoded via NYC GeoSearch |
| `early_voting_sites.geojson`   | early voting sites                                              | "GOTV Early Voting Map" (Google My Maps), exported as KML |
| `supermarkets.geojson`         | NY-12 supermarkets, with nearest cross-streets                  | campaign list (`NY-12 Grocery Stores…csv`); cross-streets derived from Manhattan street centerlines |

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
