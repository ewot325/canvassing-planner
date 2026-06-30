#!/bin/bash
# Assemble the deployable site into dist/ — ONLY the files the browser needs.
# Deliberately excludes model/ (which holds the census key + polls), serve.py,
# and other dev tooling, so nothing sensitive ever ships to Netlify.
set -e
rm -rf dist
mkdir -p dist
cp index.html app.js style.css dist/
cp -R data dist/
echo "Built dist/ with $(ls dist | wc -l | tr -d ' ') top-level entries."
