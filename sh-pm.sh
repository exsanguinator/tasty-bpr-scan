#!/bin/sh
# Scan the watchlists (portfolio margin account) into output-pm.html.
# Publishing to the Netlify site as pm.html is disabled for now; uncomment the last line to enable it.
set -eu
cd "$(dirname "$0")"

tmp=$(mktemp "${TMPDIR:-/tmp}/scan-pm.XXXXXX")
trap 'rm -f "$tmp"' EXIT

.venv/bin/python3 scan-put-bp.py --html --bpr-impact margin-scan-config.json > "$tmp"
mv "$tmp" output-pm.html
#.venv/bin/python3 publish-netlify.py output-pm.html --as pm.html
