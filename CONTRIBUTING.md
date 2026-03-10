# Contributing to the SystemLink App Store

Thank you for your interest in contributing to the SystemLink App Store! This guide explains how to submit an app for inclusion in the curated catalog.

## Overview

The App Store uses a **curated, PR-based submission process** inspired by Homebrew. You submit a Pull Request containing your app's metadata and `.nipkg` package, and maintainers review it before it becomes available in the catalog.

## Prerequisites

- A built SystemLink webapp (Angular, WebVI, or other — must produce an `index.html` at the root)
- The webapp packaged as a `.nipkg` file (see [Packaging your app](#packaging-your-app))
- An app icon (SVG or PNG, max 128×128 px)
- Optionally, up to 3 screenshots (PNG, max 800×600 px)

## Submission process

### 1. Prepare your submission directory

Create a directory under `submissions/` with your package name:

```
submissions/my-awesome-dashboard/
├── manifest.json           # App metadata (see schema below)
├── icon.svg                # App icon (SVG or PNG)
├── screenshot1.png         # Screenshot (optional, max 3)
├── screenshot2.png         # Screenshot (optional)
└── my-awesome-dashboard_1.0.0_windows_all.nipkg
```

### 2. Write your `manifest.json`

Your `manifest.json` must conform to [`app-manifest.schema.json`](app-manifest.schema.json). Here's a minimal example:

```json
{
  "package": "my-awesome-dashboard",
  "version": "1.0.0",
  "displayName": "My Awesome Dashboard",
  "description": "A comprehensive dashboard for monitoring asset health and calibration status across your SystemLink fleet.",
  "section": "WebApps",
  "maintainer": "Your Name <you@example.com>",
  "homepage": "https://github.com/yourorg/my-awesome-dashboard",
  "license": "MIT",
  "appStoreCategory": "Dashboard",
  "appStoreType": "webapp",
  "appStoreAuthor": "Your Name",
  "appStoreTags": "assets,calibration,dashboard,monitoring",
  "appStoreRepo": "https://github.com/yourorg/my-awesome-dashboard",
  "appStoreMinServerVersion": "2024 Q4",
  "nipkgFile": "my-awesome-dashboard_1.0.0_windows_all.nipkg"
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
- Check semver format for your version
- Verify `architecture` is `windows_all`
- Check for duplicate package names
- Verify `.nipkg` file size is ≤ 100 MB
- Validate required fields are present

### 5. Maintainer review

A maintainer will:

1. Install your app on a test SystemLink instance
2. Verify it works correctly
3. Check for CSP violations and security issues
4. Approve and merge

### 6. Publication

After merge, CI will:

1. Attach your `.nipkg` to a GitHub Release
2. Base64-encode your icon and screenshots
3. Regenerate the `Packages` index
4. Deploy to GitHub Pages

Your app will be available in the App Store the next time users refresh their feed.

## Requirements for submitted apps

| Requirement       | Details                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| Metadata          | All required `manifest.json` fields must be present (see schema)                       |
| Custom attributes | Must include `appStoreCategory`, `appStoreType`, `appStoreLicense`, `appStoreAuthor`   |
| Content           | `.nipkg` must contain a valid webapp (`index.html` at root) or notebook (`.ipynb`)     |
| CSP               | No external network calls outside SystemLink's own APIs                                |
| Icon              | SVG or PNG, max 128×128 px (required)                                                  |
| Description       | ≥ 20 characters                                                                        |
| License           | Must be specified (SPDX identifier or "Proprietary")                                   |
| Checksums         | SHA256 must match `.nipkg` contents                                                    |
| Version           | Valid semver (`MAJOR.MINOR.PATCH`)                                                     |
| Architecture      | Must be `windows_all`                                                                  |
| Size              | ≤ 100 MB                                                                               |
| Naming            | Package name is first-come-first-served — CI rejects duplicates from different authors |

## Packaging your app

If you use the SystemLink CLI, you can package your webapp with:

```bash
slcli appstore publish dist/browser/ \
  --name "my-awesome-dashboard" \
  --version "1.0.0" \
  --category "Dashboard" \
  --prepare-pr
```

This generates the `.nipkg` file, `manifest.json`, and a ready-to-commit branch.

Alternatively, you can manually create a `.nipkg` using NI Package Manager tools.

## Updating your app

To release a new version:

1. Update the `version` field in your `manifest.json`
2. Replace the `.nipkg` file with the new version
3. Submit a new Pull Request

---

## Automated submissions from other repositories

If your webapps live in a separate repository (e.g., `systemlink-enterprise-examples`), you can automate the submission process so that building a new version automatically creates a PR in this repository.

### How it works

```
Source repo (your webapps)              systemlink-app-store
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

1. **Create a PAT** (classic) with `repo` scope that has access to the `systemlink-app-store` repository. Store it as a secret named `APP_STORE_DISPATCH_TOKEN` in your source repository.

2. **Add a `manifest.json`** next to each webapp project in your source repo. It must conform to [`app-manifest.schema.json`](app-manifest.schema.json).

3. **Add the publish workflow** to your source repository. See [`.github/examples/publish-to-app-store.yml`](.github/examples/publish-to-app-store.yml) for a complete, ready-to-use example with a 5-app matrix build.

### Manual cross-repo submission (local)

You can also use the `submit_package.py` script directly:

```bash
# From a clone of systemlink-app-store
python scripts/submit_package.py \
    --manifest path/to/manifest.json \
    --nipkg path/to/my-app_1.0.0_windows_all.nipkg

# This creates a local branch submit/my-app-v1.0.0
# Push and open a PR:
git push origin submit/my-app-v1.0.0
```

Or download from a GitHub Release:

```bash
python scripts/submit_package.py \
    --manifest-json '{"package":"my-app","version":"1.0.0",...}' \
    --source-repo yourorg/your-repo \
    --release-tag my-app-v1.0.0 \
    --artifact-name my-app_1.0.0_windows_all.nipkg \
    --create-pr
```

### Security notes

- The `repository_dispatch` event requires an authenticated API call — only users with the PAT can trigger it.
- The submission PR goes through the same CI validation and manual review as any other submission.
- The `submit_package.py` script only downloads from `github.com` release asset URLs to prevent SSRF.
- No code from the payload is executed — only metadata and binary artifacts are handled.

---

## Delisting / Deprecation

To request removal of your app, open an issue or submit a PR removing your submission directory. Deprecation is handled by adding `AppStoreDeprecated: yes` to the metadata — the app will show a warning badge but remain visible during a grace period.

## Questions?

Open an issue on this repository if you have questions about the submission process.
