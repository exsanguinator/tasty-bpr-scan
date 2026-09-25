import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import sys
import time
from urllib.parse import quote

import requests
from dotenv import find_dotenv, load_dotenv

API = "https://api.cloudflare.com/client/v4"
DEFAULT_PROJECT = "tasty-bpr-scan"
USER_AGENT = "tasty-bpr-scan/1.0"
# Cloudflare has no endpoint that lists a deployment's files, so each deploy also
# publishes its own manifest, and the next run reads it back to keep earlier pages.
MANIFEST_PATH = "/publish-manifest.json"


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="publish-cloudflare.py",
        allow_abbrev=False,
        description=(
            "Publish HTML files to a Cloudflare Pages project. Files already on the site\n"
            "are kept unless --replace is given, so repeated runs accumulate pages."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("files", nargs="*", help="local files to publish")
    parser.add_argument(
        "--as", dest="dest", metavar="PATH",
        help="published path for a single file (default: its basename), e.g. index.html",
    )
    parser.add_argument(
        "--replace", action="store_true",
        help="drop every file currently on the site instead of keeping them",
    )
    parser.add_argument(
        "--remove", action="append", default=[], metavar="PATH",
        help="published path to take off the site, e.g. output-futures.html (repeatable)",
    )
    parser.add_argument(
        "--project", default=os.environ.get("CLOUDFLARE_PAGES_PROJECT", DEFAULT_PROJECT),
        help=f"Pages project name (default: $CLOUDFLARE_PAGES_PROJECT or {DEFAULT_PROJECT})",
    )
    args = parser.parse_args(argv)
    if args.dest and len(args.files) != 1:
        parser.error("--as takes exactly one file")
    if not args.files and not args.remove:
        parser.error("give files to publish, --remove, or both")
    if args.remove and args.replace:
        parser.error("--remove has nothing to remove after --replace")
    return args


def content_hash(data, dest):
    # wrangler keys assets by blake3(base64 + extension); any 32-hex content key works.
    ext = os.path.splitext(dest)[1].lstrip(".")
    return hashlib.sha256(base64.b64encode(data) + ext.encode()).hexdigest()[:32]


def check(resp):
    try:
        body = resp.json()
    except ValueError:
        body = None
    if resp.ok and body is not None:
        return body.get("result")
    errors = (body or {}).get("errors") or resp.text
    sys.exit(f"{resp.request.method} {resp.url} failed ({resp.status_code}): {errors}")


def main(argv):
    load_dotenv(find_dotenv(usecwd=True))
    args = parse_args(argv)
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        sys.exit("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set (add them to .env)")
    # The account ID goes into request URLs, so refuse anything else (such as a
    # token pasted into the wrong variable) rather than send it and echo it in errors.
    if not re.fullmatch(r"[0-9a-f]{32}", account):
        sys.exit("CLOUDFLARE_ACCOUNT_ID should be the 32-character hex account ID "
                 "(Cloudflare dashboard > Account home > Account ID), not a token")

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    auth = {"Authorization": f"Bearer {token}"}
    project_api = f"{API}/accounts/{account}/pages/projects/{args.project}"

    project = check(session.get(project_api, headers=auth))
    base = f"https://{project['subdomain']}"

    uploads = {}
    for path in args.files:
        with open(path, "rb") as f:
            data = f.read()
        dest = "/" + (args.dest or os.path.basename(path)).lstrip("/")
        uploads[dest] = data

    # Pages deployments are full snapshots: any path left out of the manifest is gone.
    # Start from the manifest the previous run published so earlier pages survive.
    # A missing manifest can come back as a 404 or as the site's HTML fallback page.
    manifest = {}
    if not args.replace:
        resp = session.get(base + MANIFEST_PATH, headers={"Cache-Control": "no-cache"})
        if resp.ok and "json" in resp.headers.get("Content-Type", ""):
            manifest = resp.json()
        elif resp.status_code >= 500:
            resp.raise_for_status()
    manifest.update({dest: content_hash(data, dest) for dest, data in uploads.items()})
    manifest.pop(MANIFEST_PATH, None)
    removed = []
    for path in args.remove:
        dest = "/" + path.lstrip("/")
        if manifest.pop(dest, None) is None:
            sys.exit(f"{dest} is not on the site (published: {', '.join(sorted(manifest)) or 'nothing'})")
        uploads.pop(dest, None)
        removed.append(dest)
    manifest_data = json.dumps(manifest, indent=1, sort_keys=True).encode()
    uploads[MANIFEST_PATH] = manifest_data
    manifest[MANIFEST_PATH] = content_hash(manifest_data, MANIFEST_PATH)

    jwt = check(session.get(f"{project_api}/upload-token", headers=auth))["jwt"]
    upload_auth = {"Authorization": f"Bearer {jwt}"}
    hashes = sorted(set(manifest.values()))

    # Cloudflare only asks for content it doesn't already have. That is normally just
    # the new files, but if it has dropped an old one, fetch it back from the live site.
    missing = check(session.post(
        f"{API}/pages/assets/check-missing", headers=upload_auth, json={"hashes": hashes},
    )) or []
    if missing:
        by_hash = {h: dest for dest, h in manifest.items()}
        payload = []
        for h in missing:
            dest = by_hash[h]
            data = uploads.get(dest)
            if data is None:
                resp = session.get(base + quote(dest))
                resp.raise_for_status()
                data = resp.content
            payload.append({
                "key": h,
                "value": base64.b64encode(data).decode(),
                "metadata": {
                    "contentType": mimetypes.guess_type(dest)[0] or "application/octet-stream",
                },
                "base64": True,
            })
        check(session.post(f"{API}/pages/assets/upload", headers=upload_auth, json=payload))
    check(session.post(
        f"{API}/pages/assets/upsert-hashes", headers=upload_auth, json={"hashes": hashes},
    ))

    deploy = check(session.post(
        f"{project_api}/deployments",
        headers=auth,
        files={
            "manifest": (None, json.dumps(manifest)),
            "branch": (None, project["production_branch"]),
        },
    ))

    for _ in range(60):
        stage = deploy["latest_stage"]
        if stage["status"] == "failure":
            sys.exit(f"deploy {deploy['id']} failed at stage {stage['name']}")
        if stage["name"] == "deploy" and stage["status"] == "success":
            break
        time.sleep(1)
        deploy = check(session.get(f"{project_api}/deployments/{deploy['id']}", headers=auth))
    else:
        sys.exit(f"deploy {deploy['id']} still {stage['name']}/{stage['status']} after 60s")

    for dest in uploads:
        if dest != MANIFEST_PATH:
            print(f"{base}{quote(dest)}")
    for dest in removed:
        print(f"removed {base}{quote(dest)}")


if __name__ == "__main__":
    main(sys.argv[1:])
