# SystemLink App Store — Requirements

## 1. Vision

A curated marketplace for SystemLink custom web apps, notebooks, and other extensibility packages. Users can **browse, install, upgrade, and remove** apps from both a **CLI** (`slcli`) and a **webapp** hosted inside SystemLink itself. The catalog is hosted as a standard NI Package Manager (nipkg) feed on **GitHub** using a hybrid model (Packages index via GitHub Pages, `.nipkg` binaries via GitHub Releases), and individual SystemLink instances **replicate** that feed locally so the webapp can operate within SystemLink's strict Content Security Policy (CSP).

Publishing is **curated**: all submissions go through a PR-based review process that includes functional testing and a security audit. The store starts with free/open-source contributions, with a path toward supporting commercial apps in the future.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GitHub Repository                            │
│  systemlink-app-store/                                              │
│  ├── Packages              (Debian-style index, served via Pages)   │
│  ├── Packages.gz           (compressed index)                       │
│  ├── CONTRIBUTING.md       (submission process)                     │
│  └── .github/workflows/   (CI: validate, rebuild index, sign)       │
│                                                                     │
│  GitHub Pages:   https://<org>.github.io/systemlink-app-store/      │
│                  └── serves Packages, Packages.gz                   │
│  GitHub Releases: each .nipkg attached as a release asset           │
│                   (≤ 100MB per file, no LFS needed)                 │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ packageSources URL (Pages URL)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                SystemLink Server (on-premises / cloud)              │
│                                                                     │
│  ┌──────────────┐   replicates   ┌───────────────────────┐          │
│  │ Feed Service │◄───────────────│ GitHub Pages feed URL │          │
│  │ /nifeed      │                │ (packageSources)      │          │
│  └─────┬────────┘                └───────────────────────┘          │
│        │                                                            │
│        │ /nifeed/v1/feeds/{id}/files/Packages                       │
│        ▼                                                            │
│  ┌──────────────────────────┐    ┌───────────────────────────────┐  │
│  │ App Store Webapp         │    │ slcli appstore commands       │  │
│  │ (Angular + Nimble)       │    │ (CLI — can also read GitHub   │  │
│  │ Hosted in WebApp Service │    │  directly for dev/testing)    │  │
│  └──────────────────────────┘    └───────────────────────────────┘  │
│        │                                   │                        │
│        ▼                                   ▼                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ WebApp Service — install/uninstall custom webapps            │   │
│  │ Feed Service — manage packages (nisystemlink-clients-ts)     │   │
│  │ Tag Service — install manifest + App Store config            │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Key constraints

- The App Store **webapp** can only call APIs on its own SystemLink origin (CSP `connect-src 'self'`). It cannot reach GitHub directly. Therefore it must read from the **replicated local feed**, not the GitHub URL.
- The `slcli`, running outside the browser, has no such restriction and **can read GitHub directly** for development and testing scenarios (`--source github`).
- All packages use `windows_all` architecture since webapps are platform-independent.
- All packages must use **semantic versioning** (semver: `MAJOR.MINOR.PATCH`).

---

## 3. Feed Design (GitHub-Hosted Catalog)

### 3.1 Feed format

The catalog is a standard NI Package Manager feed: a `Packages` index file (RFC 822-style, blank-line-delimited stanzas) alongside the `.nipkg` binary files. This is the same format used by `download.ni.com` and already understood by SystemLink's Feed Service.

#### First-class nipkg control fields

These fields are written to the nipkg control file and mapped by the Feed Service to **first-class** `metadata.*` properties on the package resource. Consumers should read them from the top-level `metadata` object, **not** from `metadata.attributes`.

| Control Field       | Feed Service `metadata.*` | Purpose                                                                                |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `Package`           | `packageName`             | Unique package identifier, first-come-first-served (e.g., `mycompany-asset-dashboard`) |
| `Version`           | `version`                 | **Semantic version** string (`MAJOR.MINOR.PATCH`, e.g., `1.2.0`)                       |
| `Architecture`      | `architecture`            | Always `windows_all` for App Store packages                                            |
| `Description`       | `description`             | Multi-line description of the app (≥ 20 characters)                                    |
| `Section`           | `section`                 | Category for filtering (e.g., `WebApps`, `Notebooks`, `Add-Ons`)                       |
| `Maintainer`        | `maintainer`              | Author name and email                                                                  |
| `Homepage`          | `homepage`                | Link to project/documentation / source repository                                      |
| `Tags`              | `tags`                    | Comma-separated search tags                                                            |
| `Filename`          | `fileName`                | URL to the `.nipkg` file hosted as a GitHub Release asset                              |
| `Size`              | `size`                    | File size in bytes (max **100 MB**)                                                    |
| `MD5sum` / `SHA256` | —                         | Integrity checksums (stored in attributes)                                             |

#### App Store custom attributes

These fields are stored in the nipkg control file but the Feed Service places them in the `metadata.attributes` map. They provide rich catalog browsing metadata that is specific to the App Store.

| Custom Attribute           | Purpose                                                                                                                              | Example                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `DisplayName`              | Human-readable app name shown in the store UI                                                                                        | `Asset Tracker`                             |
| `UserVisible`              | `yes` for end-user apps (filter out infrastructure packages)                                                                         | `yes`                                       |
| `DisplayVersion`           | Friendly version string (same as `Version`)                                                                                          | `1.2.0`                                     |
| `AppStoreCategory`         | Fine-grained category                                                                                                                | `Dashboard`, `Data Analysis`, `Integration` |
| `AppStoreScreenshot1`      | **Base64-encoded** screenshot image (PNG, max 800x600). **Max 3 screenshots** per app (`AppStoreScreenshot1`–`AppStoreScreenshot3`). | `data:image/png;base64,iVBOR...`            |
| `AppStoreScreenshot2`      | Second screenshot (optional)                                                                                                         | `data:image/png;base64,...`                 |
| `AppStoreScreenshot3`      | Third screenshot (optional)                                                                                                          | `data:image/png;base64,...`                 |
| `AppStoreIcon`             | **Base64-encoded** app icon (SVG or PNG, max 128x128)                                                                                | `data:image/svg+xml;base64,PH...`           |
| `AppStoreAuthor`           | Display author name                                                                                                                  | `Acme Corp`                                 |
| `AppStoreMinServerVersion` | Minimum SystemLink server version                                                                                                    | `2024 Q4`                                   |
| `AppStoreType`             | Resource type installed                                                                                                              | `webapp`, `bundle`                          |
| `AppStoreTags`             | Comma-separated search tags (mirrors `Tags` for attribute-only consumers)                                                            | `assets,calibration,dashboard`              |
| `AppStoreRepo`             | Source code repository URL (mirrors `Homepage` for attribute-only consumers)                                                         | `https://github.com/acme/asset-dash`        |
| `AppStoreLicense`          | License identifier (required)                                                                                                        | `MIT`, `Apache-2.0`, `Proprietary`          |

> **Why base64?** CSP prevents the webapp from loading images from external origins (GitHub). Base64-encoding icons and screenshots directly in the package `attributes` ensures they survive feed replication and are available to the webapp via the Feed Service API without any external requests. This does increase the `Packages` file size (several megabytes is acceptable), but keeps the architecture simple and CSP-compliant.
>
> **Screenshots are capped at 3 per app** to limit `Packages` file growth. The compressed `Packages.gz` should be used by default for feed replication to reduce bandwidth.
>
> **First-class vs. attributes**: The Feed Service automatically maps standard nipkg control fields (`Package`, `Version`, `Description`, `Section`, `Maintainer`, `Homepage`, `Tags`) to first-class `metadata` properties. Consumers (webapp, CLI) should prefer reading from the first-class properties. Fields that don't have a first-class mapping (`DisplayName`, `AppStore*`) go into `metadata.attributes` and must be read from there.

### 3.2 Repository structure

```
systemlink-app-store/
├── Packages                          # Auto-generated index (do not edit manually)
├── Packages.gz                       # Compressed index (for large catalogs)
├── submissions/                      # PR staging area for new/updated apps
│   └── mycompany-asset-dashboard/
│       ├── manifest.json             # App metadata (used to generate Packages stanza)
│       ├── icon.svg                  # App icon (auto-base64-encoded into attributes)
│       └── screenshot.png            # Screenshot (auto-base64-encoded into attributes)
├── CONTRIBUTING.md                   # How to submit an app (see §6)
├── app-manifest.schema.json          # JSON Schema for manifest.json validation
└── .github/
    └── workflows/
        ├── validate-submission.yml   # PR validation: lint metadata, check checksums
        ├── rebuild-index.yml         # On merge: regenerate Packages, base64-encode assets
        └── publish-release.yml       # Attach .nipkg to GitHub Release, update Packages
```

### 3.3 Hybrid hosting model

**`Packages` index** — served via **GitHub Pages** at:

```
https://<org>.github.io/systemlink-app-store/
```

This URL is used as the `packageSources` entry when creating the replicated feed in SystemLink.

**`.nipkg` binaries** — attached as **GitHub Release assets** (up to 2 GB per asset, no LFS needed). The `Filename` field in each `Packages` stanza points to the release asset URL:

```
https://github.com/<org>/systemlink-app-store/releases/download/v1.0.0/myapp_1.0.0_windows_all.nipkg
```

This hybrid approach keeps the git repository lean (no large binaries committed) while still serving a valid feed structure that SystemLink's Feed Service can replicate.

### 3.4 Feed signing

The feed architecture supports **OpenPGP signing** of the `Packages` index (standard NI Package Manager signed-feed support). This is not required for initial development and testing, but will be enabled once the NI OpenPGP private key is available. The CI pipeline should include a signing step that can be toggled on.

### 3.5 Feed discovery

The App Store feed is identified by a well-known feed name: `"SystemLink App Store"`. Both the webapp and CLI discover the feed by listing all feeds (`GET /nifeed/v1/feeds`) and finding the one with this name. The feed ID and configuration are stored alongside the install manifest in the Tag Service (see §8).

---

## 4. App Store Webapp (Angular + Nimble)

### 4.1 Pages / views

| View                 | Description                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog / Browse** | Grid or card layout of available apps. Filter by category, search by name/description/tags. Show icon, name, author, short description, version, and install status. |
| **App Detail**       | Full description, screenshots, version history, author info, dependencies, install/upgrade/uninstall actions.                                                        |
| **Installed**        | List of apps currently installed on this SystemLink instance. Show current version vs. latest available. Upgrade-all button.                                         |
| **Settings**         | Configure feed source URL, replication schedule, workspace targeting.                                                                                                |

### 4.2 Technical approach

- **Framework:** Angular 19, NgModule-based (per systemlink-webapp skill)
- **Design system:** `@ni/nimble-angular` — cards, table, buttons, drawers, banners, breadcrumbs, spinner
- **API calls:** Use `nisystemlink-clients-ts` for all SystemLink API calls:
  - **Feed Service** — `nisystemlink-clients-ts/feeds` (already available: `getNifeedV1Feeds`, `getNifeedV1FeedsByFeedIdPackages`, `getNifeedV1FeedsByFeedIdFilesPackages`, `postNifeedV1ReplicateFeed`, `uploadPackageToFeedAsync`, etc.)
    - **Tag Service** — `nisystemlink-clients-ts/tags` (for install manifest and config storage as a workspace-scoped STRING tag)
  - **WebApp Service** — `nisystemlink-clients-ts/web-application` (already available: `createWebapp`, `updateContent`, `deleteWebapp`, `listWebapps`, `query`, `getWebapp`, `updateWebapp`)
- **Auth:** Same-origin cookie auth (`credentials: 'include'`), no API key needed
- **Routing:** Hash-based (`useHash: true`) for SystemLink sub-path hosting
- **CSP compliance:** No `<base href>`, `APP_BASE_HREF` via DI, `inlineCritical: false`

### 4.2.1 Permission check on launch

When the App Store webapp launches, it should check that the current user has the required Web Application permissions:

- **List and view web applications** — needed to browse installed apps
- **Create, modify, and delete web applications** — needed to install/upgrade/uninstall

If permissions are missing, display a `<nimble-banner severity="warning">` explaining which permissions are required and how to request them from a SystemLink administrator. The catalog should still be browsable (read-only mode) even without install permissions.

### 4.3 Key user flows

#### Browse & install

1. Webapp loads → checks Web Application permissions, shows warning banner if insufficient
2. Discovers feed by listing feeds via `getNifeedV1Feeds()` and finding `"SystemLink App Store"`
3. Calls `getNifeedV1FeedsByFeedIdPackages()` to list all packages
4. Filters packages to `UserVisible: yes` and `AppStoreType: webapp` (or `Section: WebApps`)
5. Collapses multiple feed entries with the same `Package` name to the latest semantic version so the catalog shows one card per app
6. Renders card grid with base64-decoded icon, name, author, description, version
7. User clicks card → detail drawer/page with full info, base64-decoded screenshot
8. User clicks "Install" → choose target workspace(s) → for each workspace:
   a. Download `.nipkg` from feed via `getNifeedV1FeedsByFeedIdFilesByFileName()`
   b. Create a new webapp: `createWebapp({ name, workspace, properties })`
   c. Upload the `.nipkg` directly: `updateContent({ id }, nipkgBlob)` — no extraction needed
9. Records install in the workspace's Tag Service manifest (see §8)
10. Status updates via banner confirmation

#### Upgrade

1. Compare installed webapp versions (from manifest) against catalog versions using semver comparison
2. Show upgrade badge on cards where `catalog.version > installed.version`
3. User clicks "Upgrade" → download new `.nipkg`, re-upload via `updateContent(existingId, nipkgBlob)` for each workspace where it's installed
4. Update version in the workspace's Tag Service manifest

#### Uninstall

1. User clicks "Uninstall" → choose which workspace(s) to uninstall from (or all)
2. Confirm with modal dialog
3. `deleteWebapp({ id })` for each workspace
4. Update the workspace's Tag Service manifest (remove workspace entries, or remove app entirely if last workspace)

#### Multi-workspace management

1. User clicks "Manage" on an installed app → sees list of workspaces where it's installed
2. Can add the app to additional workspaces (installs a new webapp instance)
3. Can remove the app from specific workspaces
4. Upgrading applies to all workspaces where the app is installed

### 4.4 API surface needed

| Operation                 | Service        | SDK client         | SDK function                                              | Endpoint                                               |
| ------------------------- | -------------- | ------------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| List feeds (discovery)    | Feed Service   | `#feeds`           | `getNifeedV1Feeds()`                                      | `GET /nifeed/v1/feeds`                                 |
| List feed packages        | Feed Service   | `#feeds`           | `getNifeedV1FeedsByFeedIdPackages()`                      | `GET /nifeed/v1/feeds/{feedId}/packages`               |
| Get single package        | Feed Service   | `#feeds`           | `getNifeedV1PackagesByPackageId()`                        | `GET /nifeed/v1/packages/{packageId}`                  |
| Download Packages index   | Feed Service   | `#feeds`           | `getNifeedV1FeedsByFeedIdFilesPackages()`                 | `GET /nifeed/v1/feeds/{feedId}/files/Packages`         |
| Download package file     | Feed Service   | `#feeds`           | `getNifeedV1FeedsByFeedIdFilesByFileName()`               | `GET /nifeed/v1/feeds/{feedId}/files/{fileName}`       |
| Trigger feed sync         | Feed Service   | `#feeds`           | `postNifeedV1ReplicateFeed()`                             | `POST /nifeed/v1/replicate-feed`                       |
| Check for updates         | Feed Service   | `#feeds`           | `postNifeedV1FeedsByFeedIdCheckForUpdates()`              | `POST /nifeed/v1/feeds/{feedId}/check-for-updates`     |
| Apply updates             | Feed Service   | `#feeds`           | `postNifeedV1FeedsByFeedIdApplyUpdates()`                 | `POST /nifeed/v1/feeds/{feedId}/apply-updates`         |
| Create webapp (metadata)  | WebApp Service | `#web-application` | `createWebapp({ body: { name, workspace, properties } })` | `POST /niapp/v1/webapps`                               |
| Upload `.nipkg` to webapp | WebApp Service | `#web-application` | `updateContent({ path: { id }, body: nipkgBlob })`        | `PUT /niapp/v1/webapps/{id}/content`                   |
| List installed webapps    | WebApp Service | `#web-application` | `listWebapps({ query: { workspace } })`                   | `GET /niapp/v1/webapps`                                |
| Query webapps (advanced)  | WebApp Service | `#web-application` | `query({ body: { filter, take, orderBy } })`              | `POST /niapp/v1/query-webapps`                         |
| Get webapp details        | WebApp Service | `#web-application` | `getWebapp({ path: { id } })`                             | `GET /niapp/v1/webapps/{id}`                           |
| Update webapp metadata    | WebApp Service | `#web-application` | `updateWebapp({ path: { id }, body })`                    | `PUT /niapp/v1/webapps/{id}`                           |
| Delete a webapp           | WebApp Service | `#web-application` | `deleteWebapp({ path: { id } })`                          | `DELETE /niapp/v1/webapps/{id}`                        |
| Read install manifest     | Tag Service    | `#tags`            | `getTagWithValueInWorkspace()`                            | `GET /nitag/v2/tags/{workspace}/{path}/value`          |
| Create manifest tag       | Tag Service    | `#tags`            | `createOrReplaceTagInWorkspace()`                         | `PUT /nitag/v2/tags/{workspace}/{path}`                |
| Write install manifest    | Tag Service    | `#tags`            | `updateTagCurrentValuesInWorkspace()`                     | `PUT /nitag/v2/tags/{workspace}/{path}/values/current` |

> **Note:** The WebApp Service accepts `.nipkg` files directly via `updateContent()` — no browser-side extraction is required. The `body` parameter accepts a `Blob | File`.

### 4.5 Bootstrap & first-time setup

The App Store webapp itself is an App Store package — a "chicken-and-egg" situation. The bootstrap flow is:

1. **User downloads `AppStore.nipkg`** from the GitHub repository releases page (direct browser download — no SystemLink involved yet)
2. **User uploads `AppStore.nipkg`** to their SystemLink instance via the standard **WebApp Service UI** (drag-and-drop `.nipkg` upload)
3. **User launches the App Store webapp** from the SystemLink navigation
4. **Onboarding wizard** guides the user through first-time setup (see §4.6)

Eventually, a **GitHub Pages landing page** for the App Store project will provide a polished download experience with installation instructions, documentation, and links to the latest `.nipkg` release.

### 4.6 Onboarding flow (first-time setup)

When the App Store webapp launches and finds no install manifest in the Tag Service, it presents an onboarding wizard:

```
┌──────────────────────────────────────────────────────────────────┐
│  Welcome to the SystemLink App Store                             │
│                                                                  │
│  Step 1 of 3 — Connect to the App Store feed                     │
│                                                                  │
│  The App Store needs to replicate the package feed from GitHub    │
│  to your local SystemLink instance.                              │
│                                                                  │
│  Feed URL: [https://<org>.github.io/systemlink-app-store/    ]   │
│                                                                  │
│  [  Replicate Feed  ]                                            │
│                                                                  │
│  Step 2 of 3 — Select default workspace                          │
│  [  Default ▼  ]                                                 │
│                                                                  │
│  Step 3 of 3 — Done!                                             │
│  Your App Store is ready. Browse apps and install them.           │
│                                                                  │
│  [  Go to Catalog  ]                                             │
└──────────────────────────────────────────────────────────────────┘
```

The onboarding flow:

1. **Pre-fills the GitHub feed URL** with the official App Store feed URL
2. **Replicates the feed** on the user's behalf via `postNifeedV1ReplicateFeed()` — the user does not need to manually configure the Feed Service
3. **Creates the install manifest** in the Tag Service for the selected workspace
4. **Redirects to the catalog** once setup is complete

### 4.7 Feed refresh

Feed replication is **not automatic** — the App Store does not poll for updates. Users must explicitly trigger a feed refresh:

- **Webapp:** A "Refresh Feed" button in the Settings view (or in the catalog toolbar) calls `postNifeedV1FeedsByFeedIdCheckForUpdates()` followed by `postNifeedV1FeedsByFeedIdApplyUpdates()` if updates are available
- **CLI:** `slcli appstore feed sync` triggers the same flow

This design avoids unnecessary network traffic and gives users control over when their catalog is updated.

---

## 5. CLI Extension (`slcli appstore`)

Extend `slcli` with a new `appstore` command group for power users and CI/CD pipelines.

### 5.1 Proposed commands

```bash
# ── Discovery ──────────────────────────────────────────────────
slcli appstore list [--category TEXT] [--search TEXT] [--type webapp|notebook|bundle] [--source github|systemlink]
    # List available apps from the configured feed.
    # Default: reads from the local replicated feed on the connected SystemLink server.
    # With --source github: reads the Packages file directly from GitHub
    #   (useful for development/testing without a SystemLink server).

slcli appstore info <PACKAGE_NAME> [--source github|systemlink]
    # Show full details: description, version, author, dependencies, changelog.

slcli appstore search <QUERY> [--source github|systemlink]
    # Full-text search across name, description, tags.

# ── Installation ───────────────────────────────────────────────
slcli appstore install <PACKAGE_NAME> [--version TEXT] [--workspace NAME [NAME ...]]
    # Download the package from the feed, extract the webapp, and publish.
    # Supports installing to one or more workspaces in a single command.
    # For notebooks: upload to the notebook service.
    # Records installed version in the Tag Service manifest.

slcli appstore upgrade <PACKAGE_NAME> [--workspace NAME]
    # Upgrade to the latest version. Preserves the webapp ID.
    # Upgrades across all workspaces where the app is installed.

slcli appstore upgrade --all [--workspace NAME]
    # Upgrade all installed apps with available updates.

slcli appstore uninstall <PACKAGE_NAME> [--workspace NAME [NAME ...]]
    # Remove the webapp from specified workspaces (or all if --workspace not given).
    # Clean up the Tag Service manifest entry.

slcli appstore workspaces <PACKAGE_NAME>
    # List workspaces where this app is currently installed.

slcli appstore add-workspace <PACKAGE_NAME> --workspace NAME [NAME ...]
    # Install the app to additional workspaces (same version as currently installed).

# ── Status ─────────────────────────────────────────────────────
slcli appstore status [--workspace NAME]
    # Show installed apps and whether updates are available.

# ── Feed management ────────────────────────────────────────────
slcli appstore feed add <URL> [--name TEXT] [--workspace NAME]
    # Register a new App Store feed (creates a SystemLink feed with the given packageSource).

slcli appstore feed list
    # List configured App Store feeds.

slcli appstore feed sync [--feed-id ID]
    # Trigger replication of the feed to pull latest packages.

# ── Publishing (for app authors) ──────────────────────────────
slcli appstore publish <WEBAPP_DIR> [--manifest <FILE>] [OPTIONS]
    # Package a built webapp directory into a .nipkg with App Store metadata,
    # ready for submission to the GitHub feed via PR.
    # Reads metadata from nipkg.config.json in WEBAPP_DIR by default, or from
    # --manifest <file> if specified. CLI flags override individual config fields.
    # nipkg.config.json uses the same field names as manifest.json (package,
    # version, displayName, license, appStoreCategory, etc.) so the submission
    # manifest is generated automatically by dropping build-only fields.
    # Validates semver format, required App Store fields, and license presence.
    # Outputs: <package>_<version>_windows_all.nipkg + submissions/<package>/manifest.json
    # With --prepare-pr: creates a ready-to-commit branch with the .nipkg,
    #   manifest.json, and base64-encoded assets, streamlining the PR workflow.

slcli appstore validate <NIPKG_FILE>
    # Validate a .nipkg against App Store metadata requirements:
    # - semver version format
    # - required metadata fields present
    # - SHA256 checksum valid
    # - Architecture is windows_all
    # - Size ≤ 100MB
    # - Contains valid webapp structure (index.html at root)
    # - License specified
    # - Description ≥ 20 characters
```

### 5.2 Configuration

The CLI caches the App Store feed ID locally in `~/.config/slcli/appstore.json` for performance, but the canonical install manifest and config live in the **Tag Service** (see §8) so both the CLI and webapp share the same state.

```json
{
  "githubFeedUrl": "https://<org>.github.io/systemlink-app-store/",
  "cachedFeedId": "db7c157d-ab22-4a09-aed6-47330fa4fa59",
  "cachedAt": "2026-03-01T10:00:00Z"
}
```

The actual install manifest is stored in the Tag Service (see §8). The CLI reads/writes it the same way the webapp does.

---

## 6. Publishing Model (Homebrew-Inspired)

### 6.1 How Homebrew does it

| Homebrew concept                                                             | App Store equivalent                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Tap** — a GitHub repo containing formulae                                  | Our GitHub `systemlink-app-store` repo containing the `Packages` index  |
| **Formula / Cask** — a Ruby file describing how to install                   | A stanza in the `Packages` file + the `.nipkg` binary in `pool/`        |
| **`brew tap`** — register a third-party tap                                  | `slcli appstore feed add <URL>` — register a new feed source            |
| **`brew install`** — install from default or tapped repo                     | `slcli appstore install <name>`                                         |
| **PR-based submission** — contributors submit a PR adding/updating a formula | Contributors submit a PR adding their `.nipkg` to `pool/` with metadata |
| **CI validation** — `brew audit`, `brew test` on PR                          | GitHub Actions validates package metadata, checksums, structure         |

### 6.2 Submission workflow

```
Developer                                GitHub Repo                          Maintainers
─────────                                ───────────                          ───────────
1. Build webapp with
   `ng build --prod`
       │
2. Package with
   `slcli appstore publish dist/browser/ --prepare-pr`
       │ (reads metadata from dist/browser/nipkg.config.json;
       │  nipkg.config.json uses the same field names as manifest.json)
       │ Generates:
       │  - .nipkg file
       │  - submissions/my-app/manifest.json (derived from nipkg.config.json)
       │  - base64-encoded icon + screenshot
       │  - ready-to-commit branch
       ▼
3. Fork repo, push branch with
   submissions/my-app/ directory
       │
4. Open Pull Request ──────────────►  5. CI validates:
                                         - manifest.json against schema
                                         - semver version format
                                         - Architecture == windows_all
                                         - checksums match .nipkg
                                         - required fields present
                                         - no duplicate package names
                                         - .nipkg structure valid (index.html)
                                         - size ≤ 100 MB
                                         - license specified
                                             │
                                             ▼
                                      6. Maintainer review:
                                         - functional testing on test server
                                         - security audit (CSP, no credentials,
                                           no suspicious deps)
                                         - approve & merge
                                             │
                                             ▼
                                      7. CI on merge:
                                         - Attach .nipkg to GitHub Release
                                         - Base64-encode icon + screenshot
                                         - Regenerate Packages index
                                         - Deploy to GitHub Pages
                                         - (Optional: sign Packages with GPG)
                                             │
                                             ▼
                                      8. SystemLink instances replicate
                                         feed on next sync cycle
```

### 6.3 Requirements for submitted apps

- Must include all required `Packages` metadata fields (see §3.1)
- Must include custom App Store attributes (`AppStoreCategory`, `AppStoreType`, `AppStoreLicense`, `AppStoreAuthor`)
- `.nipkg` must contain a valid webapp (index.html at root) or notebook (.ipynb)
- No external network calls outside of SystemLink's own APIs (CSP compliance)
- Must provide an `AppStoreIcon` (SVG or PNG, max 128x128) — CI will base64-encode it
- Description must be ≥ 20 characters
- License must be specified
- SHA256 checksum must match
- Version must be valid **semver** (`MAJOR.MINOR.PATCH`)
- Architecture must be `windows_all`
- Package size must not exceed **100 MB**
- Package name is **first-come-first-served** — CI rejects duplicate names from different authors

### 6.4 Curation & review process

Publishing to the official App Store is **curated** (not open-submit). The review process includes:

1. **Automated CI checks** — metadata validation, checksum verification, semver format, size limits, structural integrity
2. **Functional testing** — maintainers install the app on a test SystemLink instance and verify it works
3. **Security audit** — review for CSP violations, hardcoded credentials, suspicious network calls, vulnerable dependencies
4. **Approval** — at least one maintainer must approve the PR before merge

### 6.5 Third-party feeds (like Homebrew Taps)

Organizations can host their own private App Store feeds:

```bash
# Register a private feed
slcli appstore feed add https://packages.acme.com/systemlink-apps/ --name "Acme Internal Apps"

# The webapp settings page also allows adding additional feed sources
```

### 6.6 Delisting & deprecation

To remove a package from the store:

1. Mark the package as deprecated in its `Packages` metadata (`AppStoreDeprecated: yes`, `AppStoreDeprecatedMessage: "Replaced by ..."`)
2. The deprecated app remains visible in the catalog with a warning badge but can no longer be installed
3. After a grace period, remove the `.nipkg` from the GitHub Release and the stanza from `Packages`
4. Users who already installed the app are not affected — their deployed webapp continues to work

---

## 7. Install / Upgrade Mechanics

### 7.1 What is a "webapp nipkg"?

A `.nipkg` package for the App Store is the standard NI Package format — a ZIP-like archive containing the webapp files. The WebApp Service accepts `.nipkg` files directly; no client-side extraction is needed.

### 7.2 Install flow

1. CLI/webapp downloads `.nipkg` from the feed via `getNifeedV1FeedsByFeedIdFilesByFileName()`
2. Creates a new webapp: `createWebapp({ body: { name, workspace, properties } })` — returns the new webapp `id`
3. Uploads the `.nipkg` directly: `updateContent({ path: { id }, body: nipkgBlob })` — the WebApp Service handles extraction internally
4. Records the mapping `packageName → webappId` in the workspace's install manifest tag (see §8)

### 7.3 Upgrade flow

1. Download new version `.nipkg` from the feed
2. Upload to the existing webapp: `updateContent({ path: { existingId }, body: nipkgBlob })` — the webapp ID is preserved
3. Update version in the workspace's install manifest tag

### 7.4 Uninstall flow

1. `deleteWebapp({ path: { id } })` — removes the webapp
2. Remove entry from the workspace's install manifest tag

---

## 8. Install Manifest (Tag Service — Per Workspace)

The install manifest tracks which App Store packages are installed. There is **one manifest per workspace**, stored as the current value of a STRING tag in the SystemLink Tag Service within that workspace. This preserves workspace-level isolation and respects SystemLink's workspace-based access control.

### 8.1 Manifest tag

Each workspace has its own manifest, stored at a well-known tag path so it can be discovered and updated consistently:

- **Tag path:** `systemlink-app-store/manifest`
- **Tag type:** `STRING`
- **Current value:** JSON-serialized manifest document
- **Workspace:** stored in the same workspace as the apps it tracks

```json
{
  "version": 1,
  "config": {
    "feedName": "SystemLink App Store",
    "feedId": "db7c157d-ab22-4a09-aed6-47330fa4fa59",
    "githubFeedUrl": "https://<org>.github.io/systemlink-app-store/"
  },
  "installedApps": {
    "mycompany-asset-dashboard": {
      "version": "1.2.0",
      "type": "webapp",
      "webappId": "3727d9ac-86e1-4d6e-820e-d2630c1b28e9",
      "installedAt": "2026-03-01T10:00:00Z",
      "updatedAt": "2026-03-09T14:30:00Z"
    },
    "calibration-tracker": {
      "version": "2.0.1",
      "type": "webapp",
      "webappId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "installedAt": "2026-03-05T09:00:00Z",
      "updatedAt": null
    }
  }
}
```

### 8.2 Manifest operations

| Operation    | Description                                                                              |
| ------------ | ---------------------------------------------------------------------------------------- |
| **Discover** | Resolve the workspace, then read the well-known tag path `systemlink-app-store/manifest` |
| **Read**     | `getTagWithValueInWorkspace({ workspace, path: 'systemlink-app-store/manifest' })`       |
| **Create**   | `createOrReplaceTagInWorkspace()` with type `STRING` in the target workspace             |
| **Update**   | `updateTagCurrentValuesInWorkspace()` with the JSON-serialized manifest                  |

### 8.3 Cross-workspace views

When the App Store webapp needs to show apps across all workspaces (e.g., the "Installed" view), it queries the manifest tag from each accessible workspace. The webapp iterates over the user's visible workspaces, reading the same well-known tag path in each workspace.

### 8.4 Concurrency

Both the webapp and CLI may read/write a workspace's manifest. Use optimistic concurrency: read the tag value, make changes, overwrite the current value. If two operations race, the last write wins. This is acceptable for the expected low frequency of install/uninstall operations.

---

## 9. Security & Governance

| Concern                  | Mitigation                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Malicious packages       | Curated PR-based review with functional testing and security audit; CI scans                                        |
| Supply-chain integrity   | SHA256 checksums verified on install; OpenPGP signing of `Packages` index (when key available)                      |
| CSP compliance           | Webapp only calls same-origin APIs; no external fetches. Icons/screenshots are base64-encoded in package attributes |
| Authorization            | Install/uninstall require Web Application create/modify/delete permissions; webapp checks on launch                 |
| Private feeds            | Organizations can host internal feeds behind VPN/auth; feed URL supports Basic Auth                                 |
| Package content scanning | CI workflow runs static analysis on `.nipkg` contents; reject packages with suspicious scripts                      |
| Naming squatting         | First-come-first-served naming; CI rejects duplicate package names from different authors                           |

---

## 10. Non-Functional Requirements

| Requirement              | Target                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| Feed replication latency | ≤ 15 minutes after merge to main                                   |
| Webapp load time         | < 3s on first load (within SystemLink infra)                       |
| Catalog size             | Support ≥ 500 packages without pagination perf issues              |
| Offline support          | Installed apps continue working when GitHub feed is unreachable    |
| Browser support          | Chrome, Edge (latest 2 versions) — matches SystemLink requirements |
| Accessibility            | Nimble components provide WCAG 2.1 AA compliance out of the box    |

---

## 11. Resolved Decisions

The following questions were raised during initial requirements drafting and have been resolved:

| #   | Question                         | Decision                                                                                                                                                                                                                                             |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GitHub hosting mechanism         | **Hybrid:** `Packages` index via GitHub Pages, `.nipkg` binaries via GitHub Releases                                                                                                                                                                 |
| 2   | Package size limits              | **100 MB** max per `.nipkg` (GitHub Release asset limit is 2 GB, so plenty of headroom)                                                                                                                                                              |
| 3   | Feed signing                     | **Supported but not blocking.** Architecture includes OpenPGP signing support; will enable once the NI private key is located                                                                                                                        |
| 4   | Architecture                     | **`windows_all`** for all App Store packages (webapps are platform-independent)                                                                                                                                                                      |
| 5   | Versioning                       | **Semantic versioning enforced** (`MAJOR.MINOR.PATCH`). CI rejects non-semver versions                                                                                                                                                               |
| 6   | Install format                   | **Keep `.nipkg`** for compatibility with the existing Feed Service replication pipeline                                                                                                                                                              |
| 7   | Install manifest                 | **Tag Service** — per-workspace STRING tag whose current value is a JSON manifest, shared between webapp and CLI (see §8)                                                                                                                            |
| 8   | Dependency resolution            | **Not required** initially. Keep it simple. `Depends` field is informational only                                                                                                                                                                    |
| 9   | Multi-workspace                  | **Supported.** Install flow allows choosing one or more workspaces; can add/remove workspaces later                                                                                                                                                  |
| 10  | Feed ID discovery                | **By name.** List feeds, find `"SystemLink App Store"`. Cache feed ID in the manifest file                                                                                                                                                           |
| 11  | Screenshots / icons              | **Base64-encoded** in package `attributes`. Max **3 screenshots** per app. `Packages.gz` for bandwidth. Survives replication, no external requests needed                                                                                            |
| 12  | Install permissions              | **Existing Web Application permissions** apply. Webapp checks permissions on launch and shows guidance                                                                                                                                               |
| 13  | Ratings / reviews                | **No.** Not in scope                                                                                                                                                                                                                                 |
| 14  | Publishing model                 | **Curated.** Submissions require functional testing and security audit by maintainers                                                                                                                                                                |
| 15  | Update notifications             | **In-app only.** Updates shown when the user opens the App Store UI                                                                                                                                                                                  |
| 16  | Naming conflicts                 | **First-come-first-served.** CI rejects duplicate package names from different authors                                                                                                                                                               |
| 17  | Delisting                        | **Mark deprecated** in metadata → warning badge → remove after grace period                                                                                                                                                                          |
| 18  | Commercial apps                  | **Future consideration.** Start with free/open-source; may support paid apps later                                                                                                                                                                   |
| 19  | CLI GitHub access                | **Yes.** `slcli appstore` supports `--source github` to browse/install directly from GitHub for dev/testing                                                                                                                                          |
| 20  | CI/CD integration                | **Yes.** `slcli appstore publish --prepare-pr` generates a ready-to-commit branch                                                                                                                                                                    |
| 21  | Packages file size with base64   | **Acceptable.** Several megabytes is fine. Cap screenshots at 3 per app. Use `Packages.gz` for feed replication                                                                                                                                      |
| 22  | Feed replication frequency       | **Manual.** Feed refresh is not automatic. Users trigger via "Refresh Feed" button in webapp or `slcli appstore feed sync` CLI command                                                                                                               |
| 23  | `.nipkg` extraction in browser   | **Not needed.** The WebApp Service accepts `.nipkg` files directly via `updateContent()`. No browser-side or server-side extraction required                                                                                                         |
| 24  | WebApp Service API for install   | **Use `#web-application` client.** `createWebapp()` + `updateContent(id, nipkgBlob)` for install; `updateContent()` for upgrade; `deleteWebapp()` for uninstall                                                                                      |
| 25  | Manifest per workspace           | **Yes.** One manifest tag per workspace in the Tag Service. Cross-workspace "Installed" view queries each accessible workspace                                                                                                                       |
| 26  | Catalog performance / pagination | **Feed Service does not appear to support pagination.** Validate performance later with real data. Client-side filtering is the initial approach                                                                                                     |
| 27  | Onboarding (first-time setup)    | **Yes.** Webapp shows an onboarding wizard that replicates the feed from GitHub on the user's behalf (see §4.6)                                                                                                                                      |
| 28  | Bootstrap (self-hosting)         | **Manual bootstrap.** User downloads `AppStore.nipkg` from GitHub Releases, uploads via SystemLink WebApp UI, then launches the App Store to complete onboarding. A GitHub Pages landing page will eventually provide a polished download experience |
| 29  | Commercial app licensing         | **Ignore for now.** Not in initial scope                                                                                                                                                                                                             |

---

## 12. Open Questions

Remaining questions that need further investigation:

### Feed & packaging

1. **GitHub Release asset URLs in Filename field:** The `Filename` field in a standard `Packages` file is normally a relative path. If we use absolute GitHub Release URLs, will the Feed Service correctly resolve and download them during replication? Need to test this with the actual replication pipeline.

---

## 13. Phased Delivery Plan

> **Repository scope:** This repository (`systemlink-app-store`) owns the static feed infrastructure, GitHub Actions CI/CD, and submission process. CLI commands (`slcli appstore`) are implemented in the `systemlink-cli` repository. The App Store webapp is implemented in a separate webapp repository.

### Phase 1a — Static Feed Infrastructure (`systemlink-app-store` repo)

- Define `app-manifest.schema.json` — JSON Schema for submission `manifest.json` files
- Set up repository structure: `submissions/`, `Packages`, `Packages.gz`, `CONTRIBUTING.md`
- Build `scripts/rebuild-index.py` — regenerate `Packages` / `Packages.gz` from submissions and GitHub Release assets, base64-encode icons and screenshots
- GitHub Actions: `validate-submission.yml` — PR validation (lint manifest against schema, check semver, check `windows_all`, validate required fields, check size ≤ 100 MB, check no duplicate package names)
- GitHub Actions: `rebuild-index.yml` — on merge to main, regenerate `Packages` index and deploy to GitHub Pages
- GitHub Actions: `publish-release.yml` — attach `.nipkg` to GitHub Release, trigger index rebuild
- Enable GitHub Pages to serve `Packages` / `Packages.gz` at the repository root
- Manually curate 3–5 example app submissions to seed the catalog

### Phase 1b — CLI (`systemlink-cli` repo)

- Build `slcli appstore publish` to create `.nipkg` from a webapp build directory with base64-encoded icon
- Build `slcli appstore validate` for pre-submission checks
- Build `slcli appstore install` / `uninstall` / `status` (using `#web-application` client: `createWebapp()` + `updateContent()`, per-workspace manifest tag in Tag Service)
- Build `slcli appstore feed sync` for manual feed refresh
- Build `--source github` support for direct GitHub browsing

### Phase 2 — Webapp

- Build the App Store Angular webapp using `nisystemlink-clients-ts` (`#feeds`, `#web-application`, `#file-ingestion`)
  - Catalog browse view with card grid (base64 icons rendered inline)
  - App detail view with base64 screenshots (max 3 per app)
  - Installed apps view with upgrade detection (semver comparison, cross-workspace query)
  - Settings view (feed refresh button, workspace selection)
- Implement onboarding wizard for first-time setup (feed replication from GitHub, manifest creation) — see §4.6
- Implement permission check on launch with guidance banner
- Implement multi-workspace install flow (per-workspace manifest tag)
- Package the App Store webapp itself as `AppStore.nipkg` and publish to GitHub Releases (bootstrap)
- Create GitHub Pages landing page with download instructions

### Phase 3 — Community & polish

- `CONTRIBUTING.md` and PR template for community submissions
- Document the curated review process (functional testing + security audit checklist)
- `slcli appstore publish --prepare-pr` for streamlined PR submission
- CI validation pipeline for submitted packages (semver, size, structure, naming)
- Multi-workspace management UI (add/remove workspaces)
- Third-party feed support (private taps)
- Feed signing toggle in CI (ready for when OpenPGP key is available)

### Phase 4 — Advanced

- Notebook and routine bundle support (beyond webapps)
- Deprecation/delisting workflow in the UI
- Usage analytics (opt-in)
- Commercial app / licensing support exploration
