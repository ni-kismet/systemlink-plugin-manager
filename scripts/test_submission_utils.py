from submission_utils import (
    validate_package_metadata,
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

metadata["displayName"] = "Example"
assert not validate_package_metadata(metadata, "example", require_embedded_icon=False)
assert any(
    "require XB-SlPluginManagerIcon" in error
    for error in validate_package_metadata(metadata, "example", require_embedded_icon=True)
)
for icon in (
    "icon.svg",
    "https://example.com/icon.svg",
    "data:image/jpeg;base64,PHN2Zy8+",
    "data:image/svg+xml;base64,",
    "data:image/svg+xml;base64,%%%invalid",
    "data:image/svg+xml;base64,PHN2Zy8",
    "data:image/svg+xml;base64,PHN2Zy8+\n",
    "data:image/svg+xml;base64,\u00e9",
):
    assert any(
        "must be a base64-encoded SVG or PNG data URI" in error
        for error in validate_package_metadata(
            {**metadata, "embeddedIcon": icon}, "example", require_embedded_icon=True
        )
    ), icon

for icon in (
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=",
):
    assert not validate_package_metadata(
        {**metadata, "embeddedIcon": icon}, "example", require_embedded_icon=True
    ), icon
