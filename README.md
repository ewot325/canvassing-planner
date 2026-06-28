# Canvassing Locations Map

A small, standalone website that shows every place the team has canvassed on an
interactive map. It runs entirely on your own computer — no login, no internet
account, no servers to maintain.

## What you get

- A **map** of every past canvassing location. Each dot is one spot.
  - **Bigger, darker dots** = places that were canvassed more (more repeat
    visits and more volunteers).
- A **sidebar list** you can search and sort.
- **Click any dot or list item** to see the dates it was active, how many
  person-days were spent there, and which volunteers went.
- An optional checkbox to **shade the election districts** by how many people
  voted in the 2025 Democratic primary, so you can see coverage vs. turnout.

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
