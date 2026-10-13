# Contributing to Plugin Manager for SystemLink

Thank you for your interest in contributing to Plugin Manager for SystemLink. This guide explains how to submit a plugin for inclusion in the curated catalog.

## Overview

The Plugin Manager uses a **curated, PR-based submission process** inspired by Homebrew. You submit a Pull Request containing your plugin metadata plus either the reviewed `.nipkg` itself or immutable GitHub release coordinates for that reviewed `.nipkg`, and maintainers review it before it becomes available in the catalog.

## Prerequisites

- A built SystemLink webapp (Angular, WebVI, or other — must produce an `index.html` at the root)
- The webapp packaged as a `.nipkg` file (see [Packaging your app](#packaging-your-app))
- Either the `.nipkg` stored in your submission directory or a GitHub release containing that exact `.nipkg`
- Package metadata embedded in the `.nipkg` control file, including `XB-DisplayName`, `XB-Plugin`, `XB-SlPluginManagerLicense`, and `XB-SlPluginManagerIcon`
- Optionally, up to 3 screenshots (PNG, max 800×600 px) stored next to the submission manifest

## Submission process

### 1. Prepare your submission directory

Create a directory under `submissions/` with your package name:

```
submissions/my-awesome-dashboard/
├── manifest.json           # Thin submission manifest (artifact path + hash)
├── screenshot1.png         # Screenshot (optional, max 3)
├── screenshot2.png         # Screenshot (optional)
└── my-awesome-dashboard_1.0.0_all.nipkg
```

If you already publish immutable release assets from another GitHub repository, you can omit the local `.nipkg` file and instead provide `sourceRepo` and `releaseTag` in the manifest. CI will download and validate the reviewed artifact from that release.

### 2. Write your `manifest.json`

Your `manifest.json` must conform to [`app-manifest.schema.json`](app-manifest.schema.json). It no longer duplicates package metadata. CI derives package name, version, display name, description, maintainer, license, plugin type, and icon directly from the reviewed `.nipkg`, whether that package is committed in the PR or resolved from the referenced GitHub release.

Minimal example:

```json
{
  "schemaVersion": 2,
  "nipkgFile": "my-awesome-dashboard_1.0.0_all.nipkg",
  "sha256": "7b7f5d9c2d6e4d6f8d89b3a5b1f7dbe4b9f6b61f4c3b98b1e2f8d0a4c6d8e1f2",
  "sourceRepo": "yourorg/my-awesome-dashboard",
  "releaseTag": "my-awesome-dashboard-v1.0.0",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "screenshots": ["screenshot1.png"]
}
```

### 3. Submit a Pull Request

1. Fork this repository
2. Create a branch: `git checkout -b add/my-awesome-dashboard`
3. Add your `submissions/my-awesome-dashboard/` directory
4. Push and open a Pull Request

### 4. CI validation

The CI pipeline will automatically:

- Validate your `manifest.json` against the JSON Schema
- Resolve the reviewed `.nipkg` from the submission directory or the referenced GitHub release
- Verify that `sha256` matches the reviewed `.nipkg`
- Inspect the `.nipkg` archive structure
- Extract package metadata from the `.nipkg` control file
- Check for duplicate package names
- Verify `.nipkg` file size is ≤ 100 MB
- Validate that the package contains the required Plugin Manager metadata
- Reject changed bytes or a missing asset for an already-published package/version

### 5. Maintainer review

A maintainer will:

1. Install your app on a test SystemLink instance
2. Verify it works correctly
3. Check for CSP violations and security issues
4. Approve and merge

### 6. Publication

After merge, CI will:

1. Create a draft GitHub Release, upload and verify the reviewed `.nipkg`, then publish it
2. Reuse the icon embedded in the `.nipkg` and base64-encode any submitted screenshots
3. Regenerate the `Packages` index
4. Deploy to GitHub Pages

Your plugin will be available in the Plugin Manager the next time users refresh their feed.

Published package versions are **write-once**, even in repositories where release
immutability is not enabled. Retrying an identical submission verifies and reuses
the published asset without modifying it. Different bytes under the same version,
or a missing asset in a published release, require a new package version. An
interrupted draft can be resumed before publication. Authentication, rate-limit,
and network errors fail the workflow rather than being treated as a missing release.

The index builder verifies that each destination release is published and its
asset SHA256 matches the submission before writing either index file. This also
applies to manual index rebuilds. If publication fails, fix the submission and
publish it before rebuilding the index; do not bypass the checksum check.

## Requirements for submitted apps

| Requirement      | Details                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest         | `manifest.json` must contain `schemaVersion`, `nipkgFile`, and the correct `sha256`                                                            |
| Artifact source  | Provide the `.nipkg` in the submission directory or provide both `sourceRepo` and `releaseTag` for a GitHub release asset matching `nipkgFile` |
| Package metadata | The `.nipkg` must contain `Section`, `XB-Plugin`, `Maintainer`, `XB-SlPluginManagerLicense`, `XB-DisplayName`, and `XB-SlPluginManagerIcon`    |
| Content          | `.nipkg` must contain a valid webapp (`index.html` at root) or notebook (`.ipynb`)                                                             |
| CSP              | No external network calls outside SystemLink's own APIs                                                                                        |
| Icon             | Must be embedded in the `.nipkg` as `XB-SlPluginManagerIcon`                                                                                   |
| Description      | ≥ 20 characters                                                                                                                                |
| License          | Must be embedded in the package metadata (SPDX identifier or "Proprietary")                                                                    |
| Checksums        | SHA256 must match `.nipkg` contents                                                                                                            |
| Version          | Valid semver (`MAJOR.MINOR.PATCH`)                                                                                                             |
| Size             | ≤ 100 MB                                                                                                                                       |
| Naming           | Package name is first-come-first-served — CI rejects duplicates from different authors                                                         |

## Packaging your app

If you use the SystemLink CLI, you can package your webapp with:

```bash
slcli plugin-manager publish dist/browser/ \
  --name "my-awesome-dashboard" \
  --version "1.0.0" \
  --category "Dashboard" \
  --prepare-pr
```

This generates the `.nipkg` file, `manifest.json`, and a ready-to-commit branch.

If you are already packaging with `@ni-kismet/sl-webapp-nipkg` in your own repository, prefer generating the thin submission manifest during the package build instead of hashing the artifact in a separate script:

```bash
./node_modules/.bin/sl-webapp-nipkg build \
  --config nipkg.config.json \
  --output-dir dist/nipkg \
  --manifest \
  --manifest-output submission-manifest.json \
  --source-repo yourorg/your-repo \
  --release-tag my-app-v1.0.0 \
  --source-commit "$(git rev-parse HEAD)"
```

This emits the reviewed `.nipkg` and the schema v2 submission manifest from the same command, which avoids metadata drift between packaging and manifest generation.

Alternatively, you can manually create a `.nipkg` using NI Package Manager tools.

## Updating your app

To release a new version:

1. Increment the version embedded in the package and build a new `.nipkg`
2. Recompute the `sha256` in your thin `manifest.json`
3. Submit a new Pull Request

Do not rebuild or replace an already-published version. Package archives may
contain timestamps, so rebuilding identical source can still produce different
bytes. The Plugin Manager webapp publisher reuses the original released package
on retries only when its committed manifest and build inputs match.

---

## Automated submissions from other repositories

If your webapps live in a separate repository (e.g., `systemlink-enterprise-examples`), you can automate the submission process so that building a new version automatically creates a PR in this repository.

### How it works

```
Source repo (your webapps)              systemlink-plugin-manager
─────────────────────────               ────────────────────
1. Build webapp (ng build)
2. Package as .nipkg
3. Attach .nipkg to GitHub Release
4. Trigger repository_dispatch ────────► 5. accept-submission.yml runs
                                         6. Downloads .nipkg from your release
                                         7. Validates manifest against schema
                                         8. Creates branch submit/<pkg>-v<ver>
                                         9. Opens PR for review
```

### Setup

1. **Create a PAT** (classic) with `repo` scope that has access to the `systemlink-plugin-manager` repository. Store it as a secret named `PLUGIN_MANAGER_DISPATCH_TOKEN` in your source repository.

2. **Generate a thin submission manifest** during your release workflow after packaging the `.nipkg`. It must conform to [`app-manifest.schema.json`](app-manifest.schema.json). If you use `@ni-kismet/sl-webapp-nipkg`, prefer generating it directly from the packaging step:

```bash
./node_modules/.bin/sl-webapp-nipkg build \
  --config nipkg.config.json \
  --output-dir dist/nipkg \
  --manifest \
  --manifest-output submission-manifest.json \
  --source-repo yourorg/your-repo \
  --release-tag my-app-v1.0.0 \
  --source-commit "$GITHUB_SHA"
```

3. **Add the publish workflow** to your source repository. See [`.github/examples/publish-to-plugin-manager.yml`](.github/examples/publish-to-plugin-manager.yml) for a complete, ready-to-use example with a 5-app matrix build.

### Manual cross-repo submission (local)

You can also use the `submit_package.py` script directly:

```bash
# From a clone of systemlink-plugin-manager
python scripts/submit_package.py \
    --manifest path/to/manifest.json \
  --nipkg path/to/my-app_1.0.0_all.nipkg

# This creates a local branch submit/my-app-v1.0.0
# Push and open a PR:
git push origin submit/my-app-v1.0.0
```

Or download from a GitHub Release:

```bash
python scripts/submit_package.py \
  --manifest-json '{"schemaVersion":2,"nipkgFile":"my-app_1.0.0_all.nipkg","sha256":"..."}' \
    --source-repo yourorg/your-repo \
    --release-tag my-app-v1.0.0 \
  --artifact-name my-app_1.0.0_all.nipkg \
    --create-pr
```

### Security notes

- The `repository_dispatch` event requires an authenticated API call — only users with the PAT can trigger it.
- The submission PR goes through the same CI validation and manual review as any other submission.
- The `submit_package.py` script only downloads from `github.com` release asset URLs to prevent SSRF.
- No code from the payload is executed — only metadata and binary artifacts are handled.

---

## Delisting / Deprecation

To request removal of your plugin, open an issue or submit a PR removing your submission directory. Deprecation is handled by adding `slPluginManagerDeprecated: yes` to the metadata — the plugin will show a warning badge but remain visible during a grace period.

## Questions?

Open an issue on this repository if you have questions about the submission process.
