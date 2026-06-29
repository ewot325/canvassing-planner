#!/bin/bash
# Double-click this file to open the Past Canvassing Locations map.
# It starts a tiny local web server in this folder and opens your browser.
# Close this Terminal window (or press Ctrl+C) when you're done to stop it.

cd "$(dirname "$0")" || exit 1
PORT=8765

echo "Starting the canvassing map at http://localhost:$PORT ..."
echo "Keep this window open while you use the map. Close it to stop."

# Open the browser a moment after the server starts.
( sleep 1 && open "http://localhost:$PORT/index.html" ) &

# Python 3 ships with macOS. serve.py serves this folder AND enables the
# in-app "Update assigned counts" button (an http.server can't do that).
python3 serve.py
