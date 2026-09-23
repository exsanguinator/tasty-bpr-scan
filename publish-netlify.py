import argparse
import hashlib
import os
import sys
import time
from urllib.parse import quote

import requests
from dotenv import find_dotenv, load_dotenv

API = "https://api.netlify.com/api/v1"
DEFAULT_SITE = "cosmic-palmier-7dd8d7.netlify.app"
USER_AGENT = "tasty-bpr-scan/1.0"


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="publish-netlify.py",
        allow_abbrev=False,
        description=(
            "Publish HTML files to a Netlify site. Files already on the site are kept\n"
            "unless --replace is given, so repeated runs accumulate pages."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("files", nargs="+", help="local files to publish")
    parser.add_argument(
        "--as", dest="dest", metavar="PATH",
        help="published path for a single file (default: its basename), e.g. index.html",
    )
    parser.add_argument(
        "--replace", action="store_true",
        help="drop every file currently on the site instead of keeping them",
    )
    parser.add_argument(
        "--site", default=os.environ.get("NETLIFY_SITE_ID", DEFAULT_SITE),
        help=f"site id or domain (default: $NETLIFY_SITE_ID or {DEFAULT_SITE})",
    )
    args = parser.parse_args(argv)
    if args.dest and len(args.files) != 1:
        parser.error("--as takes exactly one file")
    return args


def sha1(data):
    return hashlib.sha1(data).hexdigest()


def main(argv):
    load_dotenv(find_dotenv(usecwd=True))
    args = parse_args(argv)
    token = os.environ.get("NETLIFY_AUTH_TOKEN")
    if not token:
        sys.exit("NETLIFY_AUTH_TOKEN is not set (add it to .env)")

    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT})

    uploads = {}
    for path in args.files:
        with open(path, "rb") as f:
            data = f.read()
        dest = "/" + (args.dest or os.path.basename(path)).lstrip("/")
        uploads[dest] = data

    # Netlify deploys are full snapshots: any path left out of the manifest is removed.
    # Start from the current file list so earlier pages survive.
    manifest = {}
    if not args.replace:
        resp = session.get(f"{API}/sites/{args.site}/files")
        resp.raise_for_status()
        manifest = {f["id"]: f["sha"] for f in resp.json()}
    manifest.update({dest: sha1(data) for dest, data in uploads.items()})

    resp = session.post(f"{API}/sites/{args.site}/deploys", json={"files": manifest})
    resp.raise_for_status()
    deploy = resp.json()
    deploy_id = deploy["id"]

    # Netlify only asks for content it doesn't already have.
    required = set(deploy.get("required", []))
    for dest, data in uploads.items():
        if sha1(data) not in required:
            continue
        resp = session.put(
            f"{API}/deploys/{deploy_id}/files/{quote(dest.lstrip('/'))}",
            data=data,
            headers={"Content-Type": "application/octet-stream"},
        )
        resp.raise_for_status()

    for _ in range(60):
        resp = session.get(f"{API}/deploys/{deploy_id}")
        resp.raise_for_status()
        deploy = resp.json()
        if deploy["state"] == "ready":
            break
        if deploy["state"] == "error":
            sys.exit(f"deploy failed: {deploy.get('error_message')}")
        time.sleep(1)
    else:
        sys.exit(f"deploy {deploy_id} still {deploy['state']} after 60s")

    base = deploy.get("ssl_url") or deploy.get("url")
    for dest in uploads:
        print(f"{base}{quote(dest)}")


if __name__ == "__main__":
    main(sys.argv[1:])
