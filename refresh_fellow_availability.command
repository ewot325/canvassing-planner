#!/bin/bash
# Double-click this file to refresh the "fellows available per shift" numbers
# shown in the planner. It reads the latest volunteer sign-ups from the
# scheduling project's database and saves ONLY the counts (no names) into this
# map's data/ folder. Run it whenever you want the numbers brought up to date.

SCHED="$HOME/bores-scheduling/scripts"

echo "Refreshing fellow availability from the scheduling sign-ups..."

if [ ! -x "$SCHED/venv/bin/python" ]; then
  echo "Could not find the scheduling project at: $SCHED"
  echo "Make sure the bores-scheduling project is in your home folder."
  echo
  read -r -p "Press Return to close this window."
  exit 1
fi

cd "$SCHED" || exit 1
./venv/bin/python export_fellow_availability.py
STATUS=$?

echo
if [ $STATUS -eq 0 ]; then
  echo "Done. Reload the map in your browser to see the updated numbers."
else
  echo "Something went wrong (see the message above)."
fi
read -r -p "Press Return to close this window."
