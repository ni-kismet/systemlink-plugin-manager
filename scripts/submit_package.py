#!/usr/bin/env python3
"""Create or update a submission directory from a thin manifest and .nipkg."""

from __future__ import annotations

import argparse
import importlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from release_utils import check_submission, destination_repository
from submission_utils import (
    build_github_release_asset_url,
    download_file,
    extract_control_fields,
    metadata_from_control_fields,
    sha256_file,
    validate_package_metadata,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
SUBMISSIONS_DIR = REPO_ROOT / "submissions"
SCHEMA_PATH = REPO_ROOT / "app-manifest.schema.json"
GIT_COMMIT_NAME = "github-actions[bot]"
GIT_COMMIT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"


def validate_manifest(manifest: dict) -> list[str]:
    try:
        jsonschema = importlib.import_module("jsonschema")
    except ImportError:
        print(
            "Warning: jsonschema not installed, skipping schema validation",
            file=sys.stderr,
        )
        return []

    schema = json.loads(SCHEMA_PATH.read_text())
    validator = jsonschema.Draft202012Validator(schema)
    return [error.message for error in validator.iter_errors(manifest)]


def download_submission_file(url: str, dest: Path) -> None:
    print(f"Downloading {url} -> {dest}")
    download_file(url, dest, user_agent="systemlink-plugin-manager-submit")
    print(f"  Downloaded {dest.stat().st_size} bytes")


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            "git",
            "-c",
            f"user.name={GIT_COMMIT_NAME}",
            "-c",
            f"user.email={GIT_COMMIT_EMAIL}",
            *args,
        ],
        cwd=REPO_ROOT,
        check=check,
        capture_output=True,
        text=True,
    )


def resolve_nipkg(
    nipkg_path: Path | None,
    source_repo: str | None,
    release_tag: str | None,
    artifact_name: str | None,
) -> Path:
    if nipkg_path and nipkg_path.is_file():
        return nipkg_path

    if source_repo and release_tag and artifact_name:
        temp_dir = Path(tempfile.mkdtemp(prefix="submit-package-"))
        downloaded_path = temp_dir / artifact_name
        url = build_github_release_asset_url(source_repo, release_tag, artifact_name)
        download_submission_file(url, downloaded_path)
        return downloaded_path

    raise ValueError(
        "Provide either --nipkg or all of --source-repo, --release-tag, --artifact-name"
    )


def refresh_remote_submission_branch(branch: str) -> None:
    fetch_result = git(
        "fetch",
        "origin",
        f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
        check=False,
    )
    if fetch_result.returncode == 0:
        return

    stderr = fetch_result.stderr.lower()
    if "couldn't find remote ref" in stderr or "not our ref" in stderr:
        return

    raise RuntimeError(fetch_result.stderr.strip() or f"Failed to fetch remote branch {branch}")


def create_submission_branch(
    manifest: dict,
    nipkg_path: Path,
    source_repo: str | None,
    create_pr: bool,
) -> None:
    actual_sha256 = sha256_file(nipkg_path)
    if actual_sha256 != manifest["sha256"]:
        raise ValueError("manifest sha256 does not match the provided .nipkg")

    control_fields = extract_control_fields(nipkg_path)
    metadata = metadata_from_control_fields(control_fields)
    errors = validate_package_metadata(
        metadata,
        nipkg_path.name,
        require_embedded_icon=True,
    )
    if errors:
        raise ValueError("; ".join(errors))

    package = metadata["package"]
    version = metadata["version"]
    display_name = metadata["displayName"]
    nipkg_filename = manifest["nipkgFile"]

    check_submission(
        destination_repository(), f"{package}-v{version}", nipkg_filename, actual_sha256
    )

    submission_dir = SUBMISSIONS_DIR / package
    submission_dir.mkdir(parents=True, exist_ok=True)

    destination_nipkg = submission_dir / nipkg_filename
    shutil.copy2(nipkg_path, destination_nipkg)

    manifest_path = submission_dir / "manifest.json"
    with open(manifest_path, "w") as stream:
        json.dump(manifest, stream, indent=2)
        stream.write("\n")
    print(f"Wrote {manifest_path}")
    print(f"Copied .nipkg -> {destination_nipkg}")

    branch = f"submit/{package}-v{version}"
    git("fetch", "origin", "main")
    refresh_remote_submission_branch(branch)
    git("checkout", "-B", branch, "origin/main")
    git("add", str(submission_dir.relative_to(REPO_ROOT)))

    result = git("diff", "--cached", "--quiet", check=False)
    if result.returncode == 0:
        print(f"No changes to commit for {package} v{version}")
        return

    git("commit", "-m", f"feat: add {display_name} v{version}")

    if not create_pr:
        print(f"Branch '{branch}' created locally. Push and open a PR when ready:")
        print(f"  git push origin {branch}")
        return

    git("push", "--force-with-lease", "origin", branch)

    source_info = (
        f" from [{source_repo}](https://github.com/{source_repo})"
        if source_repo
        else ""
    )
    body = (
        f"## New plugin submission: {display_name} v{version}\n\n"
        f"**Package:** `{package}`\n"
        f"**Version:** `{version}`\n"
        f"**Plugin Type:** `{metadata['xbPlugin']}`\n"
        f"**Maintainer:** {metadata['maintainer']}\n"
        f"**License:** {metadata['license']}\n"
        f"**Reviewed Artifact SHA256:** `{actual_sha256}`\n"
        f"**Source:**{source_info}\n\n"
        f"---\n\n"
        f"*This PR was automatically created by the thin-manifest submission workflow.*\n"
        f"*Please review the package contents and run functional tests before merging.*"
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
        return

    if "already exists" in pr_result.stderr:
        print(f"PR already exists for branch {branch}, updated with force-push")
        return

    raise RuntimeError(pr_result.stderr.strip() or "Failed to create PR")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a Plugin Manager submission from a thin manifest and .nipkg"
    )
    manifest_group = parser.add_mutually_exclusive_group(required=True)
    manifest_group.add_argument("--manifest", type=Path, help="Path to manifest.json file")
    manifest_group.add_argument("--manifest-json", help="Inline JSON string for the manifest")

    parser.add_argument("--nipkg", type=Path, help="Path to local .nipkg file")
    parser.add_argument("--source-repo", help="GitHub repo (owner/name) containing the release asset")
    parser.add_argument("--release-tag", help="GitHub release tag containing the .nipkg")
    parser.add_argument("--artifact-name", help="Filename of the .nipkg in the release")
    parser.add_argument(
        "--create-pr",
        action="store_true",
        help="Push branch and create a PR (requires gh CLI authenticated)",
    )

    args = parser.parse_args()

    if args.manifest:
        manifest = json.loads(args.manifest.read_text())
    else:
        manifest = json.loads(args.manifest_json)

    errors = validate_manifest(manifest)
    if errors:
        print("Manifest validation errors:", file=sys.stderr)
        for error in errors:
            print(f"  ✗ {error}", file=sys.stderr)
        return 1

    try:
        nipkg_path = resolve_nipkg(
            args.nipkg,
            args.source_repo,
            args.release_tag,
            args.artifact_name,
        )
        create_submission_branch(
            manifest=manifest,
            nipkg_path=nipkg_path,
            source_repo=args.source_repo,
            create_pr=args.create_pr,
        )
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
