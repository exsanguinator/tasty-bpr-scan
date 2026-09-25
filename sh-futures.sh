#!/bin/sh
# Scan the futures watchlists and publish the results as the Cloudflare Pages site's futures.html.
set -eu
cd "$(dirname "$0")"

tmp=$(mktemp "${TMPDIR:-/tmp}/scan-futures.XXXXXX")
trap 'rm -f "$tmp"' EXIT

.venv/bin/python3 scan-put-bp.py --html --bpr-isolated margin-scan-config-futures.json > "$tmp"
mv "$tmp" output-futures.html
.venv/bin/python3 publish-cloudflare.py output-futures.html --as futures.html
