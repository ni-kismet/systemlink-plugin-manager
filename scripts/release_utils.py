"""Write-once GitHub release publishing and verification."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

from submission_utils import (
    GITHUB_REPO_PATTERN,
    NIPKG_FILENAME_RE,
    SAFE_COMPONENT_RE,
    extract_control_fields,
    metadata_from_control_fields,
    sha256_file,
    validate_package_metadata,
)

DEFAULT_REPOSITORY = "ni-kismet/systemlink-plugin-manager"


def destination_repository() -> str:
    return os.environ.get("GITHUB_REPOSITORY") or DEFAULT_REPOSITORY


def run(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(
            result.stderr.strip() or result.stdout.strip() or f"Command failed: {args[0]}"
        )
    return result.stdout


def get_release(repository: str, tag: str) -> dict | None:
    if not GITHUB_REPO_PATTERN.fullmatch(repository):
        raise ValueError(f"Invalid destination repository: {repository!r}")
    if not SAFE_COMPONENT_RE.fullmatch(tag):
        raise ValueError(f"Invalid release tag: {tag!r}")
    result = subprocess.run(
        [
            "gh", "api", "--include",
            f"repos/{repository}/releases/tags/{quote(tag, safe='')}",
        ],
        capture_output=True,
        text=True,
    )
    headers, separator, body = result.stdout.partition("\n\n")
    status = re.match(r"HTTP/\S+ (\d{3})", headers)
    if status and status.group(1) == "404":
        return None
    if result.returncode or not status or status.group(1) != "200" or not separator:
        raise RuntimeError(
            result.stderr.strip() or f"Failed to look up release {repository}/{tag}"
        )
    return json.loads(body)


def asset_digest(repository: str, release: dict, name: str) -> str:
    if not NIPKG_FILENAME_RE.fullmatch(name):
        raise ValueError(f"Invalid release artifact name: {name!r}")
    assets = [asset for asset in release["assets"] if asset["name"] == name]
    if len(assets) != 1:
        raise ValueError(
            f"{repository}/{release['tag_name']}: expected one asset named {name}; "
            "published versions are write-once. Submit a new package version."
        )
    digest = assets[0].get("digest")
    if digest:
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError(f"Unsupported release asset digest: {digest!r}")
        return digest.removeprefix("sha256:")
    with tempfile.TemporaryDirectory(prefix="release-verify-") as directory:
        run(
            "gh", "release", "download", release["tag_name"], "--repo", repository,
            "--pattern", name, "--dir", directory,
        )
        return sha256_file(Path(directory) / name)


def verify_asset(repository: str, release: dict, name: str, expected_sha: str) -> None:
    actual_sha = asset_digest(repository, release, name)
    if actual_sha != expected_sha:
        raise ValueError(
            f"{repository}/{release['tag_name']}: {name} is already published "
            f"with SHA256 {actual_sha}, but the submission has {expected_sha}. "
            "Published versions are write-once. Submit a new package version."
        )


def check_submission(
    repository: str, tag: str, name: str, expected_sha: str
) -> None:
    release = get_release(repository, tag)
    if release is not None and not release["draft"]:
        verify_asset(repository, release, name, expected_sha)


def verify_published(
    repository: str, tag: str, name: str, expected_sha: str
) -> None:
    release = get_release(repository, tag)
    if release is None or release["draft"]:
        raise ValueError(
            f"{repository}/{tag}: release is not published; cannot index {name}."
        )
    verify_asset(repository, release, name, expected_sha)


def publish(
    repository: str,
    artifact: Path,
    manifest: dict,
    target: str,
    notes: str,
    latest: bool,
) -> None:
    if not NIPKG_FILENAME_RE.fullmatch(artifact.name):
        raise ValueError(f"Invalid release artifact name: {artifact.name!r}")
    if artifact.name != manifest["nipkgFile"]:
        raise ValueError("Release artifact filename does not match manifest.json")
    expected_sha = sha256_file(artifact)
    if expected_sha != manifest["sha256"]:
        raise ValueError("Release artifact SHA256 does not match manifest.json")
    metadata = metadata_from_control_fields(extract_control_fields(artifact))
    errors = validate_package_metadata(metadata, artifact.name, require_embedded_icon=True)
    if errors:
        raise ValueError("; ".join(errors))
    tag = f"{metadata['package']}-v{metadata['version']}"
    title = f"{metadata['displayName']} v{metadata['version']}"
    release = get_release(repository, tag)
    if release is not None and not release["draft"]:
        verify_asset(repository, release, artifact.name, expected_sha)
        print(f"Reusing published release {repository}/{tag} (SHA256 verified).")
        return

    if release is None:
        run(
            "gh", "release", "create", tag, "--repo", repository, "--draft",
            "--target", target, "--title", title, "--notes", notes, "--latest=false",
        )
    else:
        run(
            "gh", "release", "edit", tag, "--repo", repository,
            "--title", title, "--notes", notes,
        )
    # Only drafts may have their assets replaced. Both publishers serialize by package.
    run(
        "gh", "release", "upload", tag, str(artifact), "--repo", repository,
        "--clobber",
    )
    uploaded = get_release(repository, tag)
    if uploaded is None:
        raise RuntimeError(f"Release {repository}/{tag} disappeared after upload")
    verify_asset(repository, uploaded, artifact.name, expected_sha)
    if not uploaded["draft"]:
        print(f"Reusing published release {repository}/{tag} (SHA256 verified).")
        return
    run(
        "gh", "release", "edit", tag, "--repo", repository,
        "--draft=false", f"--latest={str(latest).lower()}",
    )
    verify_published(repository, tag, artifact.name, expected_sha)
    print(f"Published {repository}/{tag} (SHA256 verified).")


def reuse_webapp(repository: str, tag: str, output_dir: Path, manifest_path: Path) -> bool:
    release = get_release(repository, tag)
    if release is None or release["draft"]:
        return False

    run("git", "fetch", "origin", "main")
    manifest = json.loads(
        run("git", "show", "origin/main:submissions/systemlink-plugin-manager/manifest.json")
    )
    if manifest.get("releaseTag") != tag or manifest.get("sourceRepo") != repository:
        raise ValueError(
            f"{tag}: published release does not match the committed submission; "
            "restore its manifest or submit a new package version."
        )
    source_commit = manifest.get("sourceCommit", "")
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise ValueError(f"{tag}: committed manifest has no valid sourceCommit")
    # Generated submission/index changes are not build inputs.
    try:
        run(
            "git", "diff", "--exit-code", source_commit, "HEAD", "--",
            "webapp", "package.json", "package-lock.json",
        )
    except RuntimeError as exc:
        raise ValueError(
            f"{tag}: cannot verify unchanged build inputs against {source_commit}. "
            "Published versions are write-once; submit a new package version."
        ) from exc
    verify_asset(repository, release, manifest["nipkgFile"], manifest["sha256"])
    output_dir.mkdir(parents=True, exist_ok=True)
    run(
        "gh", "release", "download", tag, "--repo", repository,
        "--pattern", manifest["nipkgFile"], "--dir", str(output_dir),
    )
    artifact = output_dir / manifest["nipkgFile"]
    if sha256_file(artifact) != manifest["sha256"]:
        raise ValueError(f"{tag}: downloaded package does not match the committed SHA256")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"path={artifact.as_posix()}\nname={artifact.name}\n")
    print(f"Reusing {tag} instead of rebuilding the published package.")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=destination_repository())
    commands = parser.add_subparsers(dest="command", required=True)
    publish_parser = commands.add_parser("publish")
    publish_parser.add_argument("--artifact", required=True, type=Path)
    publish_parser.add_argument("--manifest", required=True, type=Path)
    publish_parser.add_argument("--target", required=True)
    publish_parser.add_argument("--notes", required=True)
    publish_parser.add_argument("--latest", action="store_true")
    reuse_parser = commands.add_parser("reuse-webapp")
    reuse_parser.add_argument("--tag", required=True)
    reuse_parser.add_argument("--output-dir", required=True, type=Path)
    reuse_parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "publish":
            publish(
                args.repo, args.artifact, json.loads(args.manifest.read_text()),
                args.target, args.notes, args.latest,
            )
        else:
            reused = reuse_webapp(args.repo, args.tag, args.output_dir, args.manifest)
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"reused={str(reused).lower()}\n")
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"Release error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
