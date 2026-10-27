from __future__ import annotations

import hashlib
import io
import re
import shutil
import ssl
import subprocess
import tarfile
import tempfile
import urllib.request
from email.parser import Parser
from pathlib import Path
from typing import Any

SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
PACKAGE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
NIPKG_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.nipkg$")
SAFE_COMPONENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
GITHUB_REPO_PATTERN = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
VALID_TYPES = {"webapp", "notebook", "dashboard", "routine", "bundle"}
THIN_MANIFEST_SCHEMA_VERSION = 2
MAX_SCREENSHOTS = 3
MAX_NIPKG_SIZE_BYTES = 100 * 1024 * 1024

CONTROL_TO_METADATA_KEY = {
    "Package": "package",
    "Version": "version",
    "Description": "description",
    "Section": "section",
    "Maintainer": "maintainer",
    "Homepage": "homepage",
    "XB-DisplayName": "displayName",
    "XB-Plugin": "xbPlugin",
    "XB-SlPluginManagerLicense": "license",
    "XB-SlPluginManagerTags": "slPluginManagerTags",
    "XB-SlPluginManagerMinServerVersion": "slPluginManagerMinServerVersion",
    "XB-SlPluginManagerIcon": "embeddedIcon",
    "Architecture": "architecture",
}

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


def md5_file(path: Path) -> str:
    digest = hashlib.md5()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_github_release_asset_url(source_repo: str, release_tag: str, filename: str) -> str:
    if not GITHUB_REPO_PATTERN.match(source_repo):
        raise ValueError(f"Invalid sourceRepo format: {source_repo!r}")

    for component_name, component_value in {
        "releaseTag": release_tag,
        "nipkgFile": filename,
    }.items():
        if not SAFE_COMPONENT_RE.match(component_value):
            raise ValueError(f"Invalid {component_name}: {component_value!r}")

    return f"https://github.com/{source_repo}/releases/download/{release_tag}/{filename}"


def download_file(url: str, dest: Path, *, user_agent: str) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent})
    ssl_context = ssl.create_default_context()
    try:
        import certifi
    except ImportError:
        certifi = None

    if certifi is not None:
        ssl_context.load_verify_locations(cafile=certifi.where())

    with urllib.request.urlopen(request, timeout=120, context=ssl_context) as response:
        with open(dest, "wb") as stream:
            shutil.copyfileobj(response, stream)


def validate_submission_manifest(manifest: dict[str, Any], submission_dir: Path) -> list[str]:
    errors: list[str] = []
    submission_name = submission_dir.name

    if manifest.get("schemaVersion") != THIN_MANIFEST_SCHEMA_VERSION:
        errors.append(f"[{submission_name}] schemaVersion must be {THIN_MANIFEST_SCHEMA_VERSION}")

    nipkg_file = manifest.get("nipkgFile")
    if not nipkg_file:
        errors.append(f"[{submission_name}] Missing required field: nipkgFile")
    elif not NIPKG_FILENAME_RE.match(nipkg_file):
        errors.append(f"[{submission_name}] nipkgFile must be a filename ending in .nipkg")

    if not manifest.get("sha256"):
        errors.append(f"[{submission_name}] Missing required field: sha256")

    source_repo = manifest.get("sourceRepo")
    release_tag = manifest.get("releaseTag")
    if bool(source_repo) != bool(release_tag):
        errors.append(
            f"[{submission_name}] sourceRepo and releaseTag must be provided together for remote artifacts"
        )

    if source_repo and not GITHUB_REPO_PATTERN.match(source_repo):
        errors.append(f"[{submission_name}] sourceRepo must be in owner/name format")

    if release_tag and not SAFE_COMPONENT_RE.match(release_tag):
        errors.append(f"[{submission_name}] releaseTag contains invalid characters")

    local_nipkg = find_nipkg(submission_dir, manifest)
    if local_nipkg is None and not (source_repo and release_tag):
        errors.append(
            f"[{submission_name}] submission must include the .nipkg locally or provide sourceRepo and releaseTag"
        )

    screenshots = manifest.get("screenshots", [])
    if len(screenshots) > MAX_SCREENSHOTS:
        errors.append(f"[{submission_name}] screenshots may contain at most {MAX_SCREENSHOTS} items")

    for screenshot in screenshots:
        screenshot_path = resolve_submission_screenshot(submission_dir, screenshot)
        if screenshot_path is None:
            errors.append(
                f"[{submission_name}] screenshot must stay within the submission directory: {screenshot!r}"
            )
        elif not screenshot_path.is_file():
            errors.append(f"[{submission_name}] screenshot does not exist: {screenshot!r}")

    return errors


def resolve_submission_screenshot(
    submission_dir: Path, screenshot: str
) -> Path | None:
    submission_root = submission_dir.resolve()
    screenshot_path = (submission_root / screenshot).resolve()
    try:
        screenshot_path.relative_to(submission_root)
    except ValueError:
        return None
    return screenshot_path


def resolve_submission_nipkg(
    submission_dir: Path,
    manifest: dict[str, Any],
    *,
    user_agent: str,
    default_source_repo: str | None = None,
) -> Path | None:
    local_path = find_nipkg(submission_dir, manifest)
    if local_path is not None:
        return local_path

    source_repo = manifest.get("sourceRepo") or default_source_repo
    release_tag = manifest.get("releaseTag")
    nipkg_file = manifest.get("nipkgFile")
    if not source_repo or not release_tag or not nipkg_file:
        return None

    download_dir = Path(tempfile.mkdtemp(prefix="submission-nipkg-"))
    downloaded_path = download_dir / nipkg_file
    download_file(
        build_github_release_asset_url(source_repo, release_tag, nipkg_file),
        downloaded_path,
        user_agent=user_agent,
    )
    return downloaded_path


def find_nipkg(submission_dir: Path, manifest: dict[str, Any]) -> Path | None:
    explicit = manifest.get("nipkgFile")
    if explicit:
        candidate = submission_dir / explicit
        return candidate if candidate.is_file() else None

    matches = sorted(submission_dir.glob("*.nipkg"))
    if len(matches) == 1:
        return matches[0]
    return None


def _read_ar_members(path: Path) -> dict[str, bytes]:
    members: dict[str, bytes] = {}
    with open(path, "rb") as stream:
        if stream.read(8) != b"!<arch>\n":
            raise RuntimeError(f"{path} is not a valid ar archive")

        while True:
            header = stream.read(60)
            if not header:
                break
            if len(header) != 60:
                raise RuntimeError(f"{path} has a truncated ar header")
            if header[58:60] != b"`\n":
                raise RuntimeError(f"{path} has an invalid ar header terminator")

            raw_name = header[:16].decode("utf-8", errors="replace").strip()
            size = int(header[48:58].decode("ascii").strip())
            member_data = stream.read(size)
            if len(member_data) != size:
                raise RuntimeError(f"{path} has a truncated ar member")
            if size % 2 == 1:
                stream.read(1)

            member_name = raw_name.rstrip("/")
            members[member_name] = member_data

    return members


def validate_nipkg_archive(nipkg_path: Path, submission_name: str) -> list[str]:
    errors: list[str] = []
    try:
        members = _read_ar_members(nipkg_path)
    except RuntimeError as exc:
        return [f"[{submission_name}] {exc}"]

    if members.get("debian-binary") != b"2.0\n":
        errors.append(f"[{submission_name}] {nipkg_path.name} is missing debian-binary or has invalid contents")

    if not any(re.fullmatch(r"control\.tar\.(gz|xz|zst)", name) for name in members):
        errors.append(f"[{submission_name}] {nipkg_path.name} is missing control.tar.*")

    if not any(re.fullmatch(r"data\.tar\.(gz|xz|zst)", name) for name in members):
        errors.append(f"[{submission_name}] {nipkg_path.name} is missing data.tar.*")

    return errors


def _read_tar_member(control_archive_name: str, control_archive_data: bytes) -> str:
    if control_archive_name.endswith(".zst"):
        control_archive_data = _decompress_zstd(control_archive_data)
        mode = "r:"
    else:
        mode = "r:*"

    with tarfile.open(fileobj=io.BytesIO(control_archive_data), mode=mode) as archive:
        for member in archive.getmembers():
            if Path(member.name).name != "control":
                continue
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            return extracted.read().decode("utf-8", errors="replace")

    raise RuntimeError("control.tar archive is missing the control file")


def _decompress_zstd(data: bytes) -> bytes:
    try:
        import zstandard
    except ImportError:
        if shutil.which("zstd") is None:
            raise RuntimeError(
                "control.tar.zst is not supported without the zstandard module or zstd CLI"
            )
        result = subprocess.run(
            ["zstd", "-dc"],
            input=data,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(stderr or "zstd failed to decompress control.tar.zst")
        return result.stdout

    return zstandard.ZstdDecompressor().decompress(data)


def extract_control_fields(nipkg_path: Path) -> dict[str, str]:
    members = _read_ar_members(nipkg_path)
    control_member_name = next(
        (name for name in members if re.fullmatch(r"control\.tar\.(gz|xz|zst)", name)),
        None,
    )
    if control_member_name is None:
        raise RuntimeError(f"{nipkg_path} is missing control.tar.*")

    control_text = _read_tar_member(control_member_name, members[control_member_name])
    parsed = Parser().parsestr(control_text)
    return {key: value for key, value in parsed.items()}


def metadata_from_control_fields(control_fields: dict[str, str]) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for control_key, metadata_key in CONTROL_TO_METADATA_KEY.items():
        value = control_fields.get(control_key)
        if value:
            metadata[metadata_key] = value

    metadata.setdefault("homepage", "")
    metadata.setdefault("architecture", "all")
    return metadata


def validate_package_metadata(
    metadata: dict[str, str],
    submission_name: str,
    *,
    require_embedded_icon: bool,
) -> list[str]:
    errors: list[str] = []

    package = metadata.get("package", "")
    if not package:
        errors.append(f"[{submission_name}] Package metadata is missing 'Package'")
    elif not PACKAGE_RE.match(package):
        errors.append(f"[{submission_name}] Invalid package name: {package!r}")

    version = metadata.get("version", "")
    if not version:
        errors.append(f"[{submission_name}] Package metadata is missing 'Version'")
    elif not SEMVER_RE.match(version):
        errors.append(f"[{submission_name}] Version is not valid semver: {version!r}")

    description = metadata.get("description", "")
    if len(description) < 20:
        errors.append(
            f"[{submission_name}] Description must be >= 20 characters (got {len(description)})"
        )

    section = metadata.get("section", "")
    if len(section.strip()) < 2:
        errors.append(f"[{submission_name}] Section must be at least 2 characters")

    plugin_type = metadata.get("xbPlugin", "")
    if plugin_type not in VALID_TYPES:
        errors.append(
            f"[{submission_name}] Invalid xbPlugin: {plugin_type!r} (allowed: {VALID_TYPES})"
        )

    display_name = metadata.get("displayName", "")
    if not display_name:
        errors.append(f"[{submission_name}] Package metadata is missing 'XB-DisplayName'")
    elif any(ord(character) < 32 or ord(character) == 127 for character in display_name):
        errors.append(
            f"[{submission_name}] 'XB-DisplayName' must not contain control characters"
        )

    if not metadata.get("maintainer"):
        errors.append(f"[{submission_name}] Package metadata is missing 'Maintainer'")

    if not metadata.get("license"):
        errors.append(
            f"[{submission_name}] Package metadata is missing 'XB-SlPluginManagerLicense'"
        )

    if require_embedded_icon and not metadata.get("embeddedIcon"):
        errors.append(
            f"[{submission_name}] Thin manifests require XB-SlPluginManagerIcon in the .nipkg control metadata"
        )

    return errors
