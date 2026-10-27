from pathlib import Path
from tempfile import TemporaryDirectory

from submission_utils import (
    resolve_submission_screenshot,
    validate_package_metadata,
    validate_submission_manifest,
)


with TemporaryDirectory() as temporary_directory:
    root = Path(temporary_directory)
    submission = root / "submission"
    submission.mkdir()
    screenshot = submission / "preview.png"
    screenshot.write_bytes(b"image")
    outside = root / "private"
    outside.write_text("private")
    (submission / "linked.png").symlink_to(outside)

    assert resolve_submission_screenshot(submission, "preview.png") == screenshot.resolve()
    assert resolve_submission_screenshot(submission, "../private") is None
    assert resolve_submission_screenshot(submission, "linked.png") is None
    assert any(
        "must stay within the submission directory" in error
        for error in validate_submission_manifest(
            {"screenshots": ["../private"]}, submission
        )
    )

metadata = {
    "package": "example",
    "version": "1.0.0",
    "description": "A valid package description.",
    "section": "utility",
    "xbPlugin": "webapp",
    "displayName": "Unsafe\nname",
    "maintainer": "Example",
    "license": "MIT",
}
assert any(
    "must not contain control characters" in error
    for error in validate_package_metadata(
        metadata, "example", require_embedded_icon=False
    )
)
