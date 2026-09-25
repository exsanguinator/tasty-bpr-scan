#!/bin/sh
# Scan the REG-T watchlists and publish the results as the Cloudflare Pages site's home page.
set -eu
cd "$(dirname "$0")"

tmp=$(mktemp "${TMPDIR:-/tmp}/scan-regt.XXXXXX")
trap 'rm -f "$tmp"' EXIT

.venv/bin/python3 scan-put-bp.py --html --bpr-isolated margin-scan-config-regt.json > "$tmp"
mv "$tmp" output-regt.html
.venv/bin/python3 publish-cloudflare.py output-regt.html --as index.html
