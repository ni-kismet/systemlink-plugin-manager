from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import rebuild_index
import release_utils
import submit_package
from submission_utils import extract_control_fields, metadata_from_control_fields, sha256_file

REPOSITORY = "ni-kismet/systemlink-plugin-manager"
TAG = "test-app-v1.0.0"
NAME = "test-app_1.0.0_all.nipkg"
SOURCE_COMMIT = "a" * 40
REAL_SUBPROCESS_RUN = subprocess.run


def make_package(path: Path) -> None:
    control = (
        "Package: test-app\nVersion: 1.0.0\n"
        "XB-DisplayName: Test App\n"
        "Description: A test package for release verification\n"
        "Section: Utilities\nMaintainer: Test Maintainer\n"
        "XB-Plugin: webapp\nXB-SlPluginManagerLicense: MIT\n"
        "XB-SlPluginManagerIcon: data:image/svg+xml;base64,PHN2Zy8+\n"
    ).encode()
    members = {"debian-binary": b"2.0\n"}
    for name, contents in (("control", control), ("index.html", b"<html></html>")):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            info = tarfile.TarInfo(name)
            info.size = len(contents)
            archive.addfile(info, io.BytesIO(contents))
        members["control.tar.gz" if name == "control" else "data.tar.gz"] = buffer.getvalue()
    with path.open("wb") as stream:
        stream.write(b"!<arch>\n")
        for name, contents in members.items():
            header = (
                f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(contents):<10}`\n"
            )
            stream.write(header.encode())
            stream.write(contents)
            if len(contents) % 2:
                stream.write(b"\n")


class FakeGitHub:
    """Enforce immutable assets while exercising the real gh command construction."""

    def __init__(self, artifact: Path, manifest: dict, release: dict | None):
        self.artifact = artifact
        self.manifest = manifest
        self.release = release
        self.calls: list[tuple[str, ...]] = []
        self.lookup_error: int | None = None
        self.changed_inputs = False
        self.corrupt_upload = False
        self.corrupt_download = False
        self.list_error = False
        self.list_pages: list[list[dict]] | None = None

    def run(self, args, **kwargs):
        args = tuple(args)
        self.calls.append(args)
        if args[:2] == ("gh", "api"):
            if "--paginate" in args:
                if self.list_error:
                    return subprocess.CompletedProcess(args, 1, "", "HTTP 403")
                pages = self.list_pages
                if pages is None:
                    pages = [[self.release] if self.release is not None else []]
                return subprocess.CompletedProcess(args, 0, json.dumps(pages), "")
            visible_by_tag = self.release is not None and not self.release["draft"]
            status = self.lookup_error or (200 if visible_by_tag else 404)
            body = json.dumps(self.release or {"message": "Not Found"})
            return subprocess.CompletedProcess(
                args, 0 if status == 200 else 1,
                f"HTTP/2.0 {status} Status\nContent-Type: application/json\n\n{body}",
                "" if status == 200 else f"HTTP {status}",
            )
        if args[:3] == ("gh", "release", "create"):
            self.release = {"tag_name": args[3], "draft": True, "assets": []}
        elif args[:3] == ("gh", "release", "upload"):
            if not self.release["draft"]:
                return subprocess.CompletedProcess(args, 1, "", "Cannot delete asset from an immutable release")
            self.release["assets"] = [{
                "name": self.artifact.name,
                "digest": "sha256:" + ("0" * 64 if self.corrupt_upload else sha256_file(self.artifact)),
            }]
        elif args[:3] == ("gh", "release", "edit"):
            if not self.release["draft"]:
                raise AssertionError("Must not edit a published release")
            if "--draft=false" in args:
                self.release["draft"] = False
        elif args[:3] == ("gh", "release", "download"):
            directory = Path(args[args.index("--dir") + 1])
            (directory / self.artifact.name).write_bytes(
                b"corrupt" if self.corrupt_download else self.artifact.read_bytes()
            )
        elif args[:2] == ("git", "fetch"):
            pass
        elif args[:2] == ("git", "show"):
            return subprocess.CompletedProcess(args, 0, json.dumps(self.manifest), "")
        elif args[:2] == ("git", "diff"):
            if self.changed_inputs:
                return subprocess.CompletedProcess(args, 1, "Changed build inputs", "")
        else:
            raise AssertionError(f"Unexpected command: {args}")
        return subprocess.CompletedProcess(args, 0, "", "")

    def mutations(self):
        return [call for call in self.calls if call[:2] == ("gh", "release") and call[2] != "download"]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.artifact = self.root / NAME
        make_package(self.artifact)
        self.sha = sha256_file(self.artifact)
        self.manifest = {
            "schemaVersion": 2, "nipkgFile": NAME, "sha256": self.sha,
            "sourceRepo": REPOSITORY, "releaseTag": TAG, "sourceCommit": SOURCE_COMMIT,
        }
        self.release = {
            "tag_name": TAG, "draft": False, "immutable": True,
            "assets": [{"name": NAME, "digest": f"sha256:{self.sha}"}],
        }
        self.github = FakeGitHub(self.artifact, self.manifest, self.release)
        self.addCleanup(patch.stopall)
        patch("release_utils.subprocess.run", side_effect=self.github.run).start()
        self.output = self.root / "output"
        patch.dict(os.environ, {"GITHUB_OUTPUT": str(self.output), "GITHUB_REPOSITORY": REPOSITORY}).start()

    def publish(self):
        release_utils.publish(REPOSITORY, self.artifact, self.manifest, SOURCE_COMMIT, "Notes", False)

    def test_identical_published_retry_never_mutates_release(self):
        self.publish()
        self.assertEqual(self.github.mutations(), [])

    def test_same_version_different_bytes_rejected_before_upload(self):
        self.release["assets"][0]["digest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "new package version"):
            self.publish()
        self.assertEqual(self.github.mutations(), [])

    def test_published_mutable_release_is_also_write_once(self):
        self.release["immutable"] = False
        self.publish()
        self.assertEqual(self.github.mutations(), [])

    def test_published_missing_asset_rejected(self):
        self.release["assets"] = []
        with self.assertRaisesRegex(ValueError, "expected one asset"):
            self.publish()
        self.assertEqual(self.github.mutations(), [])

    def test_new_release_is_draft_until_upload_verified(self):
        self.github.release = None
        self.publish()
        mutations = self.github.mutations()
        self.assertEqual([call[2] for call in mutations], ["create", "upload", "edit"])
        self.assertIn("--draft", mutations[0])
        self.assertIn(SOURCE_COMMIT, mutations[0])
        self.assertIn("--draft=false", mutations[-1])
        self.assertIn("--latest=false", mutations[-1])
        self.assertFalse(self.github.release["draft"])

    def test_manager_release_is_marked_latest_only_on_publication(self):
        self.github.release = None
        release_utils.publish(REPOSITORY, self.artifact, self.manifest, SOURCE_COMMIT, "Notes", True)
        self.assertIn("--latest=false", self.github.mutations()[0])
        self.assertIn("--latest=true", self.github.mutations()[-1])

    def test_interrupted_draft_can_resume(self):
        self.release["draft"] = True
        self.release["assets"] = []
        self.publish()
        self.assertEqual([call[2] for call in self.github.mutations()], ["edit", "upload", "edit"])

    def test_draft_hidden_by_tag_is_found_in_paginated_list(self):
        self.release["draft"] = True
        self.github.list_pages = [
            [{"tag_name": "unrelated-v1.0.0", "draft": False, "assets": []}],
            [self.release],
        ]
        self.assertEqual(release_utils.get_release(REPOSITORY, TAG), self.release)
        self.assertTrue(any("--paginate" in call for call in self.github.calls))

    def test_list_error_after_tag_404_does_not_create_release(self):
        self.github.release = None
        self.github.list_error = True
        with self.assertRaisesRegex(RuntimeError, "403"):
            self.publish()
        self.assertEqual(self.github.mutations(), [])

    def test_bad_upload_never_published(self):
        self.github.release = None
        self.github.corrupt_upload = True
        with self.assertRaises(ValueError):
            self.publish()
        self.assertTrue(self.github.release["draft"])
        self.assertFalse(any("--draft=false" in call for call in self.github.calls))

    def test_only_404_is_absence(self):
        self.github.release = None
        self.assertIsNone(release_utils.get_release(REPOSITORY, TAG))
        for status in (401, 403, 429, 500):
            with self.subTest(status=status):
                self.github.lookup_error = status
                with self.assertRaisesRegex(RuntimeError, str(status)):
                    self.publish()
        self.assertEqual(self.github.mutations(), [])

    def test_transport_failure_is_not_absence(self):
        with patch("release_utils.subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "TLS error")):
            with self.assertRaisesRegex(RuntimeError, "TLS error"):
                release_utils.get_release(REPOSITORY, TAG)

    def test_malformed_response_is_not_absence(self):
        with patch("release_utils.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "invalid", "")):
            with self.assertRaises(RuntimeError):
                release_utils.get_release(REPOSITORY, TAG)

    def test_legacy_asset_without_digest_is_downloaded_and_hashed(self):
        del self.release["assets"][0]["digest"]
        self.publish()
        self.assertTrue(any(call[:3] == ("gh", "release", "download") for call in self.github.calls))
        self.assertEqual(self.github.mutations(), [])

    def test_corrupt_legacy_download_fails(self):
        del self.release["assets"][0]["digest"]
        self.github.corrupt_download = True
        with self.assertRaises(ValueError):
            self.publish()

    def test_manifest_hash_mismatch_fails_before_lookup(self):
        self.manifest["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "manifest"):
            self.publish()
        self.assertEqual(self.github.calls, [])

    def test_manifest_filename_mismatch_fails_before_lookup(self):
        self.manifest["nipkgFile"] = "different.nipkg"
        with self.assertRaisesRegex(ValueError, "filename"):
            self.publish()
        self.assertEqual(self.github.calls, [])

    def test_cli_failure_is_actionable_and_nonzero(self):
        manifest_path = self.root / "manifest.json"
        manifest_path.write_text(json.dumps(self.manifest))
        self.release["assets"][0]["digest"] = "sha256:" + "0" * 64
        error = io.StringIO()
        with (
            patch.object(sys, "argv", [
                "release_utils.py", "publish", "--artifact", str(self.artifact),
                "--manifest", str(manifest_path), "--target", SOURCE_COMMIT,
                "--notes", "Notes",
            ]),
            contextlib.redirect_stderr(error),
        ):
            self.assertEqual(release_utils.main(), 1)
        self.assertIn("new package version", error.getvalue())
        self.assertEqual(self.github.mutations(), [])

    def test_submission_allows_unpublished_version(self):
        self.github.release = None
        release_utils.check_submission(REPOSITORY, TAG, NAME, self.sha)

    def test_submission_rejects_published_changed_bytes(self):
        with self.assertRaisesRegex(ValueError, "new package version"):
            release_utils.check_submission(REPOSITORY, TAG, NAME, "0" * 64)

    def test_index_requires_published_matching_asset(self):
        release_utils.verify_published(REPOSITORY, TAG, NAME, self.sha)
        for release in (None, {"tag_name": TAG, "draft": True, "assets": []}):
            self.github.release = release
            with self.assertRaisesRegex(ValueError, "cannot index"):
                release_utils.verify_published(REPOSITORY, TAG, NAME, self.sha)

    def test_reuse_downloads_original_bytes_and_preserves_manifest(self):
        manifest_path = self.root / "manifest.json"
        self.assertTrue(release_utils.reuse_webapp(REPOSITORY, TAG, self.root / "reused", manifest_path))
        self.assertEqual((self.root / "reused" / NAME).read_bytes(), self.artifact.read_bytes())
        self.assertEqual(json.loads(manifest_path.read_text()), self.manifest)
        self.assertIn(f"name={NAME}", self.output.read_text())
        self.assertEqual(self.github.mutations(), [])

    def test_reuse_rejects_changed_build_inputs(self):
        self.github.changed_inputs = True
        with self.assertRaisesRegex(ValueError, "build inputs"):
            release_utils.reuse_webapp(REPOSITORY, TAG, self.root / "reused", self.root / "manifest.json")
        self.assertFalse((self.root / "reused").exists())

    def test_reuse_rejects_stale_committed_manifest(self):
        self.manifest["releaseTag"] = "test-app-v0.9.0"
        with self.assertRaisesRegex(ValueError, "committed submission"):
            release_utils.reuse_webapp(REPOSITORY, TAG, self.root / "reused", self.root / "manifest.json")

    def test_reuse_verifies_real_git_build_inputs(self):
        repo = self.root / "repo"
        (repo / "webapp").mkdir(parents=True)
        (repo / "webapp" / "input.js").write_text("original build input")
        (repo / "package.json").write_text("{}")

        def git(*args):
            return REAL_SUBPROCESS_RUN(
                ["git", "-c", "user.name=Regression Test", "-c", "user.email=test@example.invalid", *args],
                cwd=repo, check=True, capture_output=True, text=True,
            ).stdout

        git("init")
        git("add", ".")
        git("commit", "-m", "Build inputs")
        self.manifest["sourceCommit"] = git("rev-parse", "HEAD").strip()
        manifest_path = repo / "submissions" / "systemlink-plugin-manager" / "manifest.json"
        manifest_path.parent.mkdir(parents=True)
        manifest_path.write_text(json.dumps(self.manifest))
        git("add", ".")
        git("commit", "-m", "Generated manifest")
        git("update-ref", "refs/remotes/origin/main", "HEAD")

        def run(args, **kwargs):
            if args[0] == "gh" or args[:2] == ("git", "fetch"):
                return self.github.run(args, **kwargs)
            return REAL_SUBPROCESS_RUN(args, cwd=repo, **kwargs)

        with patch("release_utils.subprocess.run", side_effect=run):
            self.assertTrue(release_utils.reuse_webapp(
                REPOSITORY, TAG, self.root / "reused", manifest_path,
            ))
            (repo / "webapp" / "input.js").write_text("changed build input")
            git("add", ".")
            git("commit", "-m", "Change build inputs without a version bump")
            with self.assertRaisesRegex(ValueError, "build inputs"):
                release_utils.reuse_webapp(REPOSITORY, TAG, self.root / "changed", manifest_path)

    def test_reuse_checks_downloaded_bytes_even_with_api_digest(self):
        self.github.corrupt_download = True
        with self.assertRaisesRegex(ValueError, "downloaded package"):
            release_utils.reuse_webapp(REPOSITORY, TAG, self.root / "reused", self.root / "manifest.json")

    def test_new_webapp_version_is_built_normally(self):
        self.github.release = None
        self.assertFalse(release_utils.reuse_webapp(REPOSITORY, TAG, self.root / "reused", self.root / "manifest.json"))

    def test_submit_rejects_conflict_before_writing_or_git_changes(self):
        self.release["assets"][0]["digest"] = "sha256:" + "0" * 64
        destination = self.root / "submissions"
        with patch.object(submit_package, "SUBMISSIONS_DIR", destination):
            with self.assertRaisesRegex(ValueError, "new package version"):
                submit_package.create_submission_branch(self.manifest, self.artifact, None, False)
        self.assertFalse(destination.exists())
        self.assertFalse(any(call[0] == "git" for call in self.github.calls))

    def run_index(self, validate_only=False):
        submissions = self.root / "submissions"
        submissions.mkdir(exist_ok=True)
        (submissions / "test-app").mkdir(exist_ok=True)
        (submissions / "test-app" / "manifest.json").write_text(json.dumps(self.manifest))
        metadata = metadata_from_control_fields(extract_control_fields(self.artifact))
        packages = self.root / "Packages"
        packages.write_text("Existing index\n")
        compressed = self.root / "Packages.gz"
        compressed.write_bytes(b"Existing compressed index")
        with (
            patch.object(rebuild_index, "SUBMISSIONS_DIR", submissions),
            patch.object(rebuild_index, "PACKAGES_PATH", packages),
            patch.object(rebuild_index, "PACKAGES_GZ_PATH", compressed),
            patch.object(rebuild_index, "load_submission", return_value=(self.manifest, metadata, self.artifact, [])),
            patch.object(sys, "argv", ["rebuild_index.py"] + (["--validate-only"] if validate_only else [])),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            status = rebuild_index.main()
        return status, packages, compressed

    def test_index_conflict_preserves_both_existing_files(self):
        self.release["assets"][0]["digest"] = "sha256:" + "0" * 64
        status, packages, compressed = self.run_index()
        self.assertEqual(status, 1)
        self.assertEqual(packages.read_text(), "Existing index\n")
        self.assertEqual(compressed.read_bytes(), b"Existing compressed index")

    def test_validate_only_checks_conflict_without_requiring_new_release(self):
        self.github.release = None
        self.assertEqual(self.run_index(validate_only=True)[0], 0)
        self.github.release = self.release
        self.release["assets"][0]["digest"] = "sha256:" + "0" * 64
        self.assertEqual(self.run_index(validate_only=True)[0], 1)

    def test_index_writes_verified_asset_hash_and_url(self):
        status, packages, _ = self.run_index()
        self.assertEqual(status, 0)
        self.assertIn(f"SHA256: {self.sha}", packages.read_text())
        self.assertIn(f"/releases/download/{TAG}/{NAME}", packages.read_text())


if __name__ == "__main__":
    unittest.main()
