#!/usr/bin/env python3
"""Create (or update) a submission directory and optionally open a PR.

This script is the automation backbone for cross-repo publishing.  It can be
invoked in two ways:

1. **Locally / from any CI** — point it at a built .nipkg + manifest.json and
   it creates a ready-to-push branch.
2. **From the accept-submission.yml workflow** — receives manifest JSON and
   artifact coordinates via arguments, downloads the .nipkg from a GitHub
   Release, and opens a PR via ``gh pr create``.

Usage examples
--------------
# Local: create a submission branch from an existing .nipkg
python scripts/submit_package.py \\
    --manifest submissions/my-app/manifest.json \\
    --nipkg path/to/my-app_1.0.0_windows_all.nipkg

# CI (accept-submission.yml): manifest inline, download from release
python scripts/submit_package.py \\
    --manifest-json '{"package":"my-app","version":"1.0.0",...}' \\
    --source-repo ni-kismet/systemlink-enterprise-examples \\
    --release-tag my-app-v1.0.0 \\
    --artifact-name my-app_1.0.0_windows_all.nipkg \\
    --create-pr
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SUBMISSIONS_DIR = REPO_ROOT / "submissions"
SCHEMA_PATH = REPO_ROOT / "app-manifest.schema.json"

# Only allow downloads from github.com release assets to prevent SSRF
ALLOWED_DOWNLOAD_PATTERN = re.compile(
    r"^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/"
    r"releases/download/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.nipkg$"
)

ALLOWED_ASSET_PATTERN = re.compile(
    r"^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/"
    r"releases/download/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.(svg|png|jpg|jpeg)$"
)

GITHUB_REPO_PATTERN = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


def validate_manifest(manifest: dict) -> list[str]:
    """Validate manifest against the JSON schema. Returns error messages."""
    try:
        import jsonschema
    except ImportError:
        print(
            "Warning: jsonschema not installed, skipping schema validation",
            file=sys.stderr,
        )
        return []

    schema = json.loads(SCHEMA_PATH.read_text())
    validator = jsonschema.Draft202012Validator(schema)
    return [e.message for e in validator.iter_errors(manifest)]


def safe_download_url(source_repo: str, release_tag: str, filename: str) -> str:
    """Construct and validate a GitHub Release asset download URL."""
    if not GITHUB_REPO_PATTERN.match(source_repo):
        raise ValueError(f"Invalid source_repo format: {source_repo!r}")

    # Sanitize components — only allow safe characters
    for component in [release_tag, filename]:
        if not re.match(r"^[A-Za-z0-9._-]+$", component):
            raise ValueError(f"Invalid characters in: {component!r}")

    url = (
        f"https://github.com/{source_repo}/releases/download/"
        f"{release_tag}/{filename}"
    )

    if not ALLOWED_DOWNLOAD_PATTERN.match(url):
        raise ValueError(f"URL does not match allowed pattern: {url}")

    return url


def safe_asset_url(source_repo: str, release_tag: str, filename: str) -> str:
    """Construct and validate a GitHub Release image asset URL."""
    if not GITHUB_REPO_PATTERN.match(source_repo):
        raise ValueError(f"Invalid source_repo format: {source_repo!r}")

    for component in [release_tag, filename]:
        if not re.match(r"^[A-Za-z0-9._-]+$", component):
            raise ValueError(f"Invalid characters in: {component!r}")

    url = (
        f"https://github.com/{source_repo}/releases/download/"
        f"{release_tag}/{filename}"
    )

    if not ALLOWED_ASSET_PATTERN.match(url):
        raise ValueError(f"Asset URL does not match allowed pattern: {url}")

    return url


def download_file(url: str, dest: Path) -> None:
    """Download a file from a validated URL."""
    print(f"Downloading {url} → {dest}")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "systemlink-plugin-manager-submit"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        with open(dest, "wb") as f:
            shutil.copyfileobj(response, f)
    print(f"  Downloaded {dest.stat().st_size} bytes")


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run a git command in REPO_ROOT."""
    return subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        check=check,
        capture_output=True,
        text=True,
    )


def create_submission_branch(
    manifest: dict,
    nipkg_path: Path | None,
    source_repo: str | None,
    release_tag: str | None,
    artifact_name: str | None,
    icon_url: str | None,
    create_pr: bool,
) -> None:
    """Create a git branch with the submission and optionally open a PR."""
    pkg = manifest["package"]
    version = manifest["version"]
    display_name = manifest.get("displayName", pkg)

    submission_dir = SUBMISSIONS_DIR / pkg
    submission_dir.mkdir(parents=True, exist_ok=True)

    # Write manifest.json
    manifest_path = submission_dir / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"Wrote {manifest_path}")

    # Resolve .nipkg file
    if nipkg_path and nipkg_path.is_file():
        # Local file — copy into submission dir
        dest = submission_dir / nipkg_path.name
        if dest != nipkg_path:
            shutil.copy2(nipkg_path, dest)
        print(f"Copied .nipkg → {dest}")
    elif source_repo and release_tag and artifact_name:
        # Download from GitHub Release
        url = safe_download_url(source_repo, release_tag, artifact_name)
        dest = submission_dir / artifact_name
        download_file(url, dest)
    else:
        print(
            "Warning: No .nipkg provided — submission will be incomplete",
            file=sys.stderr,
        )

    # Download icon if provided as URL
    if icon_url and source_repo and release_tag:
        icon_filename = icon_url.rsplit("/", 1)[-1] if "/" in icon_url else icon_url
        try:
            url = safe_asset_url(source_repo, release_tag, icon_filename)
            icon_dest = submission_dir / icon_filename
            download_file(url, icon_dest)
        except ValueError as e:
            print(f"Warning: Could not download icon: {e}", file=sys.stderr)

    # Create branch and commit
    branch = f"submit/{pkg}-v{version}"

    # Ensure we're on a clean base
    git("fetch", "origin", "main")
    git("checkout", "-B", branch, "origin/main")

    # Stage submission directory
    git("add", str(submission_dir.relative_to(REPO_ROOT)))

    # Check if there are changes to commit
    result = git("diff", "--cached", "--quiet", check=False)
    if result.returncode == 0:
        print(f"No changes to commit for {pkg} v{version}")
        return

    git("commit", "-m", f"feat: add {display_name} v{version}")

    if create_pr:
        # Push and create PR
        git("push", "--force-with-lease", "origin", branch)

        source_info = (
            f" from [{source_repo}](https://github.com/{source_repo})"
            if source_repo
            else ""
        )
        body = (
            f"## New plugin submission: {display_name} v{version}\n\n"
            f"**Package:** `{pkg}`\n"
            f"**Version:** `{version}`\n"
            f"**Plugin Type:** `{manifest.get('xbPlugin', manifest.get('appStoreType', 'unknown'))}`\n"
            f"**Maintainer:** {manifest.get('maintainer', 'unknown')}\n"
            f"**License:** {manifest.get('license', 'unknown')}\n"
            f"**Source:**{source_info}\n\n"
            f"---\n\n"
            f"*This PR was automatically created by the cross-repo Plugin Manager submission workflow.*\n"
            f"*Please review the submission and run functional tests before merging.*"
        )

        pr_result = subprocess.run(
            [
                "gh",
                "pr",
                "create",
                "--base",
                "main",
                "--head",
                branch,
                "--title",
                f"Add {display_name} v{version}",
                "--body",
                body,
                "--label",
                "submission",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

        if pr_result.returncode == 0:
            print(f"PR created: {pr_result.stdout.strip()}")
        else:
            # PR may already exist — try to update it
            if "already exists" in pr_result.stderr:
                print(f"PR already exists for branch {branch}, updated with force-push")
            else:
                print(f"Failed to create PR: {pr_result.stderr}", file=sys.stderr)
                sys.exit(1)
    else:
        print(f"Branch '{branch}' created locally. Push and open a PR when ready:")
        print(f"  git push origin {branch}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a Plugin Manager submission from a .nipkg and manifest"
    )

    # Manifest source — file or inline JSON
    manifest_group = parser.add_mutually_exclusive_group(required=True)
    manifest_group.add_argument(
        "--manifest",
        type=Path,
        help="Path to manifest.json file",
    )
    manifest_group.add_argument(
        "--manifest-json",
        help="Inline JSON string for the manifest",
    )

    # .nipkg source — local file or GitHub Release coordinates
    parser.add_argument(
        "--nipkg",
        type=Path,
        help="Path to local .nipkg file",
    )
    parser.add_argument(
        "--source-repo",
        help="GitHub repo (owner/name) containing the release asset",
    )
    parser.add_argument(
        "--release-tag",
        help="GitHub release tag containing the .nipkg",
    )
    parser.add_argument(
        "--artifact-name",
        help="Filename of the .nipkg in the release",
    )

    parser.add_argument(
        "--icon-url",
        help="URL or filename of the icon in the release assets",
    )
    parser.add_argument(
        "--create-pr",
        action="store_true",
        help="Push branch and create a PR (requires gh CLI authenticated)",
    )

    args = parser.parse_args()

    # Load manifest
    if args.manifest:
        manifest = json.loads(args.manifest.read_text())
    else:
        manifest = json.loads(args.manifest_json)

    # Validate
    errors = validate_manifest(manifest)
    if errors:
        print("Manifest validation errors:", file=sys.stderr)
        for e in errors:
            print(f"  ✗ {e}", file=sys.stderr)
        return 1

    # Ensure we have a .nipkg source
    if not args.nipkg and not (
        args.source_repo and args.release_tag and args.artifact_name
    ):
        print(
            "Error: Provide either --nipkg or all of --source-repo, --release-tag, --artifact-name",
            file=sys.stderr,
        )
        return 1

    create_submission_branch(
        manifest=manifest,
        nipkg_path=args.nipkg,
        source_repo=args.source_repo,
        release_tag=args.release_tag,
        artifact_name=args.artifact_name,
        icon_url=args.icon_url,
        create_pr=args.create_pr,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
