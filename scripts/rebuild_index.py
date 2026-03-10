#!/usr/bin/env python3
"""Rebuild the Packages index from submissions/ directories and GitHub Release assets.

Reads each submissions/<name>/manifest.json, validates it, base64-encodes any
icon/screenshot files, and writes out a Packages (and Packages.gz) index file
in the NI Package Manager feed format (RFC 822-style stanzas).

Usage:
    python scripts/rebuild_index.py [--repo-url URL]

The --repo-url flag sets the GitHub repository URL used to construct Filename
entries pointing at release assets.  Defaults to the GITHUB_REPOSITORY
environment variable (set automatically by GitHub Actions).
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SUBMISSIONS_DIR = REPO_ROOT / "submissions"
SCHEMA_PATH = REPO_ROOT / "app-manifest.schema.json"
PACKAGES_PATH = REPO_ROOT / "Packages"
PACKAGES_GZ_PATH = REPO_ROOT / "Packages.gz"

SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")

REQUIRED_FIELDS = [
    "package",
    "version",
    "displayName",
    "description",
    "section",
    "maintainer",
    "license",
    "appStoreCategory",
    "appStoreType",
    "appStoreAuthor",
]

VALID_SECTIONS = {"WebApps", "Notebooks", "Add-Ons"}
VALID_TYPES = {"webapp", "notebook", "routine", "bundle"}

MAX_SCREENSHOTS = 3
MAX_PACKAGE_SIZE_MB = 100


def base64_encode_file(path: Path) -> str:
    """Return a data-URI string for a file (image)."""
    mime, _ = mimetypes.guess_type(str(path))
    if mime is None:
        if path.suffix.lower() == ".svg":
            mime = "image/svg+xml"
        else:
            mime = "application/octet-stream"
    with open(path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def md5_file(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def hash_remote_file(url: str) -> tuple[int, str, str]:
    """Download a remote asset and return (size, sha256, md5)."""
    sha256 = hashlib.sha256()
    md5 = hashlib.md5()
    size = 0

    request = urllib.request.Request(
        url,
        headers={"User-Agent": "systemlink-app-store-index-builder"},
    )

    with urllib.request.urlopen(request, timeout=60) as response:
        for chunk in iter(lambda: response.read(8192), b""):
            size += len(chunk)
            sha256.update(chunk)
            md5.update(chunk)

    return size, sha256.hexdigest(), md5.hexdigest()


def hash_remote_file_with_curl(url: str) -> tuple[int, str, str]:
    """Download a remote asset with curl and return (size, sha256, md5)."""
    if shutil.which("curl") is None:
        raise RuntimeError("curl is not available for remote asset download fallback")

    sha256 = hashlib.sha256()
    md5 = hashlib.md5()
    size = 0

    process = subprocess.Popen(
        ["curl", "-LfsS", url],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    assert process.stdout is not None
    for chunk in iter(lambda: process.stdout.read(8192), b""):
        size += len(chunk)
        sha256.update(chunk)
        md5.update(chunk)

    stderr = process.communicate()[1].decode("utf-8", errors="replace").strip()
    if process.returncode != 0:
        raise RuntimeError(stderr or f"curl failed with exit code {process.returncode}")

    return size, sha256.hexdigest(), md5.hexdigest()


def validate_manifest(manifest: dict, submission_dir: Path) -> list[str]:
    """Validate a manifest dict. Return list of error strings (empty = OK)."""
    errors: list[str] = []
    name = submission_dir.name

    for field in REQUIRED_FIELDS:
        if field not in manifest:
            errors.append(f"[{name}] Missing required field: {field}")

    pkg = manifest.get("package", "")
    if pkg and not re.match(r"^[a-z0-9][a-z0-9._-]*$", pkg):
        errors.append(f"[{name}] Invalid package name: {pkg!r}")

    version = manifest.get("version", "")
    if version and not SEMVER_RE.match(version):
        errors.append(f"[{name}] Version is not valid semver: {version!r}")

    desc = manifest.get("description", "")
    if len(desc) < 20:
        errors.append(
            f"[{name}] Description must be >= 20 characters (got {len(desc)})"
        )

    section = manifest.get("section", "")
    if section and section not in VALID_SECTIONS:
        errors.append(
            f"[{name}] Invalid section: {section!r} (allowed: {VALID_SECTIONS})"
        )

    app_type = manifest.get("appStoreType", "")
    if app_type and app_type not in VALID_TYPES:
        errors.append(
            f"[{name}] Invalid appStoreType: {app_type!r} (allowed: {VALID_TYPES})"
        )

    return errors


def find_nipkg(submission_dir: Path, manifest: dict) -> Path | None:
    """Find the .nipkg file in a submission directory."""
    explicit = manifest.get("nipkgFile")
    if explicit:
        candidate = submission_dir / explicit
        return candidate if candidate.is_file() else None

    nipkgs = list(submission_dir.glob("*.nipkg"))
    if len(nipkgs) == 1:
        return nipkgs[0]
    return None


def build_stanza(manifest: dict, submission_dir: Path, repo_url: str) -> str:
    """Build a single Packages stanza from a manifest + submission dir."""
    pkg = manifest["package"]
    version = manifest["version"]

    # Find .nipkg
    nipkg_path = find_nipkg(submission_dir, manifest)
    nipkg_filename = manifest.get("nipkgFile") or (
        nipkg_path.name
        if nipkg_path and nipkg_path.is_file()
        else f"{pkg}_{version}_all.nipkg"
    )

    # Construct Filename URL pointing to GitHub Release asset
    filename_url = f"{repo_url}/releases/download/{pkg}-v{version}/{nipkg_filename}"

    # Compute checksums and size from the .nipkg if present
    if nipkg_path and nipkg_path.is_file():
        size = nipkg_path.stat().st_size
        sha256 = sha256_file(nipkg_path)
        md5 = md5_file(nipkg_path)
    else:
        try:
            size, sha256, md5 = hash_remote_file(filename_url)
        except urllib.error.URLError as exc:
            try:
                size, sha256, md5 = hash_remote_file_with_curl(filename_url)
            except RuntimeError as curl_exc:
                raise RuntimeError(
                    f"[{submission_dir.name}] Could not resolve release asset {filename_url}: {curl_exc}"
                ) from exc

    lines = [
        f"Architecture: all",
        f"Description: {manifest['description']}",
        f"DisplayName: {manifest['displayName']}",
        f"DisplayVersion: {version}",
        f"Filename: {filename_url}",
        f"Homepage: {manifest.get('homepage', '')}",
        f"MD5sum: {md5}",
        f"Maintainer: {manifest['maintainer']}",
        f"Package: {pkg}",
        f"Section: {manifest['section']}",
        f"SHA256: {sha256}",
        f"Size: {size}",
        f"UserVisible: yes",
        f"Version: {version}",
    ]

    # App Store custom attributes
    attrs = {
        "AppStoreCategory": manifest.get("appStoreCategory", ""),
        "AppStoreType": manifest.get("appStoreType", ""),
        "AppStoreAuthor": manifest.get("appStoreAuthor", ""),
        "AppStoreLicense": manifest.get("license", ""),
    }
    if manifest.get("appStoreTags"):
        attrs["AppStoreTags"] = manifest["appStoreTags"]
    if manifest.get("appStoreRepo"):
        attrs["AppStoreRepo"] = manifest["appStoreRepo"]
    if manifest.get("appStoreMinServerVersion"):
        attrs["AppStoreMinServerVersion"] = manifest["appStoreMinServerVersion"]

    # Base64-encode icon
    for icon_name in ["icon.svg", "icon.png"]:
        icon_path = submission_dir / icon_name
        if icon_path.is_file():
            attrs["AppStoreIcon"] = base64_encode_file(icon_path)
            break

    # Base64-encode screenshots (max 3)
    for i in range(1, MAX_SCREENSHOTS + 1):
        for ext in [".png", ".jpg", ".jpeg"]:
            screenshot_path = submission_dir / f"screenshot{i}{ext}"
            if screenshot_path.is_file():
                attrs[f"AppStoreScreenshot{i}"] = base64_encode_file(screenshot_path)
                break

    for key, value in sorted(attrs.items()):
        if value:
            lines.append(f"{key}: {value}")

    return "\n".join(lines)


def get_repo_url(args_repo_url: str | None) -> str:
    """Determine the GitHub repository URL."""
    if args_repo_url:
        return args_repo_url.rstrip("/")

    gh_repo = os.environ.get("GITHUB_REPOSITORY")
    if gh_repo:
        return f"https://github.com/{gh_repo}"

    return "https://github.com/ni-kismet/systemlink-app-store"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild Packages index from submissions/"
    )
    parser.add_argument(
        "--repo-url",
        help="GitHub repository URL for constructing release asset URLs",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only validate manifests, don't write Packages files",
    )
    args = parser.parse_args()

    repo_url = get_repo_url(args.repo_url)

    if not SUBMISSIONS_DIR.is_dir():
        print("No submissions/ directory found. Creating empty Packages file.")
        PACKAGES_PATH.write_text("")
        return 0

    all_errors: list[str] = []
    stanzas: list[str] = []
    seen_packages: dict[str, str] = {}  # package name -> submission dir name

    submission_dirs = sorted(
        d
        for d in SUBMISSIONS_DIR.iterdir()
        if d.is_dir() and (d / "manifest.json").is_file()
    )

    for submission_dir in submission_dirs:
        manifest_path = submission_dir / "manifest.json"
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            all_errors.append(
                f"[{submission_dir.name}] Failed to read manifest.json: {e}"
            )
            continue

        errors = validate_manifest(manifest, submission_dir)
        all_errors.extend(errors)

        if errors:
            continue

        # Check for duplicate package names
        pkg_name = manifest["package"]
        if pkg_name in seen_packages:
            all_errors.append(
                f"[{submission_dir.name}] Duplicate package name '{pkg_name}' "
                f"(already defined in {seen_packages[pkg_name]})"
            )
            continue
        seen_packages[pkg_name] = submission_dir.name

        try:
            stanzas.append(build_stanza(manifest, submission_dir, repo_url))
        except RuntimeError as exc:
            all_errors.append(str(exc))

    if all_errors:
        print("Validation errors:", file=sys.stderr)
        for err in all_errors:
            print(f"  ✗ {err}", file=sys.stderr)
        return 1

    if args.validate_only:
        print(f"✓ {len(stanzas)} submission(s) validated successfully.")
        return 0

    # Write Packages file (blank-line-separated stanzas)
    packages_content = "\n\n".join(stanzas)
    if packages_content:
        packages_content += "\n"
    PACKAGES_PATH.write_text(packages_content)
    print(f"✓ Wrote {PACKAGES_PATH} ({len(stanzas)} package(s))")

    # Write Packages.gz
    with gzip.open(PACKAGES_GZ_PATH, "wt", encoding="utf-8") as gz:
        gz.write(packages_content)
    print(f"✓ Wrote {PACKAGES_GZ_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
