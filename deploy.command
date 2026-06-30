#!/bin/bash
# Double-click to deploy the latest Canvassing Planner to Netlify
# (https://bores-canvassing-planner.netlify.app). Builds only the site files +
# the serverless functions; never ships the model folder or any secret.
cd "$(dirname "$0")" || exit 1
export PATH=/opt/homebrew/bin:$PATH
# reuse the Netlify token stored with the scheduling project
export NETLIFY_AUTH_TOKEN=$(grep '^NETLIFY_AUTH_TOKEN=' "$HOME/bores-scheduling/scripts/.env" 2>/dev/null | cut -d= -f2-)
if [ -z "$NETLIFY_AUTH_TOKEN" ]; then
  echo "Couldn't find the Netlify token in ~/bores-scheduling/scripts/.env"
  read -r -p "Press Return to close this window."
  exit 1
fi
echo "Deploying the canvassing planner to Netlify…"
netlify deploy --prod --build
echo
echo "Done — live at https://bores-canvassing-planner.netlify.app"
read -r -p "Press Return to close this window."
