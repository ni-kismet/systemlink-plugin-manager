# Proposal: App Store Metadata Support in `sl-webapp-nipkg`

**Package:** [`@ni-kismet/sl-webapp-nipkg`](https://github.com/ni/sl-webapp-nipkg) v0.3.0  
**Issue type:** Bug (silent field drop) + Feature request (App Store metadata)

---

## Background

`sl-webapp-nipkg` is used in this project's CI to build `.nipkg` files for the
SystemLink App Store. The App Store feed format requires a specific set of
control file fields (both standard nipkg fields and custom `AppStore*` attributes)
so that the Feed Service can populate `metadata.*` and `metadata.attributes` on
each package resource. Without these fields, packages are invisible in the catalog.

---

## 1. Bugs Found in v0.3.0

### 1.1 `displayName` and `userVisible` are silently dropped

`NipkgConfig` documents `displayName` and `userVisible` and they appear in the
README example config. The builder passes them to deboa's `controlFileOptions`:

```js
// builder.js (current)
const controlFileOptions = {
    maintainer: ...,
    packageName: ...,
    ...(this.config.displayName && { displayName: this.config.displayName }),
    ...(this.config.userVisible !== undefined && { userVisible: String(this.config.userVisible) }),
};
```

However, deboa's `#createControlFile()` only writes the standard Debian fields
it knows about. `displayName` and `userVisible` are accepted but never written
to the control file:

```js
// deboa/classes/Deboa.js — destructures ONLY these fields:
const {
  controlFileOptions: {
    packageName,
    version,
    section,
    priority,
    architecture,
    maintainer,
    homepage,
    suggests,
    depends,
    recommends,
    shortDescription,
    extendedDescription,
    builtUsing,
    conflicts,
    essential,
    preDepends,
  },
} = this;
// displayName and userVisible are NOT in this list → silently dropped
```

**Impact:** Any package built with `sl-webapp-nipkg` that sets `displayName` or
`userVisible` will have those omitted from the control file, with no warning.

### 1.2 `section` and `homepage` are not wired up

Deboa supports `Section` and `Homepage` fields natively, but `sl-webapp-nipkg`
does not expose them in `NipkgConfig` or pass them through — even though they
are required for App Store packages (`Section: WebApps`, `Homepage: <repo-url>`).

---

## 2. Missing Features Required for App Store

The App Store Packages index format (see `REQUIREMENTS.md §3.1`) requires the
following fields that are completely absent from `sl-webapp-nipkg`:

### 2.1 Standard nipkg fields not exposed

| Field      | Required for                                                     | Currently available?    |
| ---------- | ---------------------------------------------------------------- | ----------------------- |
| `Section`  | Feed Service `metadata.section`; App Store category routing      | ❌ Not in `NipkgConfig` |
| `Homepage` | Feed Service `metadata.homepage`; repo link displayed in catalog | ❌ Not in `NipkgConfig` |
| `Tags`     | Feed Service `metadata.tags`; full-text search                   | ❌ Not in `NipkgConfig` |

### 2.2 App Store custom attributes (written as extra control fields)

These fields are placed in `metadata.attributes` by the Feed Service and are
used exclusively by the App Store catalog UI:

| Control Field              | Purpose                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `DisplayName`              | Human-readable name shown in the catalog card                 |
| `UserVisible`              | `yes` / `no` — filters out infrastructure packages            |
| `AppStoreCategory`         | Fine-grained category (Dashboard, Data Analysis, etc.)        |
| `AppStoreIcon`             | Base64-encoded SVG/PNG icon (data URI, max 128×128)           |
| `AppStoreScreenshot1`      | Base64-encoded screenshot (data URI, max 800×600)             |
| `AppStoreScreenshot2`      | Second screenshot (optional)                                  |
| `AppStoreScreenshot3`      | Third screenshot (optional)                                   |
| `AppStoreAuthor`           | Display author/company name                                   |
| `AppStoreType`             | Resource type: `webapp`, `notebook`, `bundle`                 |
| `AppStoreTags`             | Comma-separated tags (mirrors `Tags` for attribute consumers) |
| `AppStoreRepo`             | Source repository URL                                         |
| `AppStoreLicense`          | SPDX license identifier (required: `MIT`, `Apache-2.0`, etc.) |
| `AppStoreMinServerVersion` | Minimum SystemLink server version (e.g. `2024 Q4`)            |

### 2.3 No general escape hatch for arbitrary control fields

There is no `extraControlFields` or equivalent in `NipkgConfig` to write
project-specific control file fields without a code change.

---

## 3. Root Cause: deboa Doesn't Support Custom Fields

The underlying `deboa` library only writes standard Debian control fields. Any
extra keys passed in `controlFileOptions` are silently ignored. Since
`sl-webapp-nipkg` delegates all control file generation to deboa, it has no way
to append custom fields without modifying the packaging pipeline.

There are three viable implementation paths:

### Option A — Post-process the control file in deboa's temp directory _(difficult)_

Hook between `Deboa` construction and `deboa.package()` to inject extra lines
into the temp control file. Not possible because `#controlFolderDestination` is
a private class field.

### Option B — Submit `extraControlFields` to deboa _(ideal long-term)_

File an upstream PR against [deboa](https://github.com/nicolo-ribaudo/deboa) to
add `controlFileOptions.extraFields?: Record<string, string>` which are appended
verbatim to the control file lines. Until that lands, use Option C as interim.

### Option C — Self-contained control file generation in `sl-webapp-nipkg` _(recommended)_

`sl-webapp-nipkg` writes its own control file to a temp directory, creates the
`control.tar.gz` directly using Node's `tar` stream API, then uses deboa's
`DeboaFromFile` class to assemble the final `.deb`/`.nipkg` from the two
pre-built tarballs:

```
control.tar.gz  (built by sl-webapp-nipkg — full field set)
data.tar.gz     (built by sl-webapp-nipkg — ApplicationFiles_64/...)
     ↓
DeboaFromFile.writeFromFile(controlTarGz)
DeboaFromFile.writeFromFile(dataTarGz)
     ↓
<package>.nipkg
```

`DeboaFromFile` (already an internal deboa export) accepts pre-built tar files
and assembles the final `ar` archive. This gives `sl-webapp-nipkg` full control
over the control file without forking deboa.

---

## 4. Proposed Changes to `sl-webapp-nipkg`

### 4.1 Update `NipkgConfig` interface

`NipkgConfig` is redesigned as a **flat structure** that mirrors
[`manifest.json`](../app-manifest.schema.json) field names for all App Store metadata.
This means a `nipkg.config.json` can be mechanically projected to a `manifest.json`
submission by dropping the build-specific fields — no manual mapping or translation
required. The separate `AppStoreMetadata` nested object is removed.

```typescript
export interface NipkgConfig {
  // ── Metadata fields (mirror manifest.json field names exactly) ─────────────

  /** Unique package identifier. Lowercase with hyphens/dots/underscores. */
  package: string;

  /** Semantic version (MAJOR.MINOR.PATCH). */
  version: string;

  /** Human-readable display name shown in the catalog card. */
  displayName?: string;

  /** Short description of the app (≥ 20 characters for App Store). */
  description?: string;

  /** Package section. E.g. 'WebApps'. Written as Section: in control file. */
  section?: string;

  /** Author name and email. E.g. 'Acme Corp <apps@acme.com>'. */
  maintainer?: string;

  /** Homepage / repository URL. Written as Homepage: in control file. */
  homepage?: string;

  /** SPDX license identifier (required for App Store). E.g. 'MIT'. */
  license?: string;

  /** Fine-grained App Store category. E.g. 'Dashboard'. */
  appStoreCategory?: string;

  /** Resource type installed. */
  appStoreType?: "webapp" | "notebook" | "bundle";

  /** Display author / company name shown in the catalog. */
  appStoreAuthor?: string;

  /** Comma-separated search tags. E.g. 'assets,calibration,dashboard'. */
  appStoreTags?: string;

  /** Source repository URL (mirrors Homepage for attribute-only consumers). */
  appStoreRepo?: string;

  /** Minimum SystemLink server version. E.g. '2024 Q4'. */
  appStoreMinServerVersion?: string;

  // ── nipkg-specific metadata (not present in manifest.json) ─────────────────

  /** Whether to show in the App Store catalog. @defaultValue 'yes' */
  userVisible?: "yes" | "no";

  /**
   * Standard nipkg Tags field. Written as Tags: in control file and surfaced as
   * metadata.tags first-class property. Falls back to appStoreTags if omitted.
   */
  tags?: string;

  /** Path to app icon file (SVG or PNG, max 128×128 px). Will be base64-encoded. */
  iconFile?: string;

  /** Paths to up to 3 screenshot files (PNG, max 800×600 px). Will be base64-encoded. */
  screenshotFiles?: [string?, string?, string?];

  // ── Build settings (omitted when generating manifest.json) ─────────────────

  /** Directory containing the built app. E.g. 'dist/browser'. */
  buildDir?: string;

  /** Command to run before packaging. E.g. 'npm run build'. */
  buildCommand?: string;

  /** Debian-style package dependencies. */
  depends?: string[];

  /** CPU architecture. @defaultValue 'all' */
  architecture?: string;

  /** Deployment configuration. */
  deployment?: Record<string, unknown>;

  /**
   * Arbitrary extra control file fields, written verbatim as `Key: value` lines.
   * @example { "AppStoreCustomField": "value" }
   */
  extraControlFields?: Record<string, string>;
}
```

### 4.2 Fix control file generation in `builder.ts`

Replace the deboa `controlFileOptions` block with a method that generates all
control file lines directly (fixing the silent-drop bugs) and collects extra
fields:

```typescript
private buildControlFileLines(): string[] {
  const cfg = this.config;
  const lines: string[] = [];

  // Standard fields
  lines.push(`Package: ${cfg.package}`);
  lines.push(`Version: ${cfg.version}`);
  if (cfg.section)             lines.push(`Section: ${cfg.section}`);
  lines.push(`Priority: optional`);
  lines.push(`Architecture: ${cfg.architecture ?? 'all'}`);
  if (cfg.maintainer)          lines.push(`Maintainer: ${cfg.maintainer}`);
  if (cfg.depends?.length)     lines.push(`Depends: ${cfg.depends.join(', ')}`);
  if (cfg.homepage)            lines.push(`Homepage: ${cfg.homepage}`);
  const tags = cfg.tags ?? cfg.appStoreTags;
  if (tags)                    lines.push(`Tags: ${tags}`);
  lines.push(`Description: ${cfg.description ?? ''}`);
  lines.push(` ${cfg.description ?? ''}`); // extended description (RFC 822 continuation)

  // App Store attributes — read from flat config, same field names as manifest.json
  if (cfg.displayName)              lines.push(`DisplayName: ${cfg.displayName}`);
  lines.push(`UserVisible: ${cfg.userVisible ?? 'yes'}`);
  if (cfg.appStoreCategory)         lines.push(`AppStoreCategory: ${cfg.appStoreCategory}`);
  if (cfg.iconFile)                 lines.push(`AppStoreIcon: ${encodeFileAsBase64(cfg.iconFile)}`);
  if (cfg.screenshotFiles?.[0])     lines.push(`AppStoreScreenshot1: ${encodeFileAsBase64(cfg.screenshotFiles[0])}`);
  if (cfg.screenshotFiles?.[1])     lines.push(`AppStoreScreenshot2: ${encodeFileAsBase64(cfg.screenshotFiles[1])}`);
  if (cfg.screenshotFiles?.[2])     lines.push(`AppStoreScreenshot3: ${encodeFileAsBase64(cfg.screenshotFiles[2])}`);
  if (cfg.appStoreAuthor)           lines.push(`AppStoreAuthor: ${cfg.appStoreAuthor}`);
  if (cfg.appStoreType)             lines.push(`AppStoreType: ${cfg.appStoreType}`);
  if (cfg.appStoreTags)             lines.push(`AppStoreTags: ${cfg.appStoreTags}`);
  if (cfg.appStoreRepo)             lines.push(`AppStoreRepo: ${cfg.appStoreRepo}`);
  if (cfg.license)                  lines.push(`AppStoreLicense: ${cfg.license}`);
  if (cfg.appStoreMinServerVersion) lines.push(`AppStoreMinServerVersion: ${cfg.appStoreMinServerVersion}`);

  // General escape hatch
  for (const [key, value] of Object.entries(cfg.extraControlFields ?? {})) {
    lines.push(`${key}: ${value}`);
  }

  return lines;
}
```

Then write this to `<tempDir>/control/control` before calling deboa — or bypass
deboa's control generation entirely using the Option C approach above.

### 4.3 Update `nipkg.config.json` schema and `init` command

The generated `nipkg.config.json` skeleton should use flat, `manifest.json`-compatible
field names, with the build-only fields clearly separated by a comment:

```json
{
  "package": "my-awesome-dashboard",
  "version": "1.0.0",
  "displayName": "My Awesome Dashboard",
  "description": "A comprehensive dashboard for monitoring asset health.",
  "section": "WebApps",
  "maintainer": "Your Name <name@example.com>",
  "homepage": "https://github.com/your-org/your-repo",
  "license": "MIT",
  "appStoreCategory": "Dashboard",
  "appStoreType": "webapp",
  "appStoreAuthor": "Your Org",
  "appStoreTags": "assets,calibration,dashboard,monitoring",
  "appStoreRepo": "https://github.com/your-org/your-repo",
  "appStoreMinServerVersion": "2024 Q4",
  "iconFile": "src/assets/icon.svg",

  "_build": "── build settings below are not included in manifest.json ──",
  "buildDir": "dist/browser",
  "buildCommand": "npm run build"
}
```

### 4.4 Manifest compatibility

Because `nipkg.config.json` now uses the exact same field names as `manifest.json`
for all metadata, generating the submission manifest is a pure projection: copy all
fields except the build-specific group, and add the `nipkgFile` field:

| `nipkg.config.json` field  | `manifest.json` field      | Notes                             |
| -------------------------- | -------------------------- | --------------------------------- |
| `package`                  | `package`                  | identical                         |
| `version`                  | `version`                  | identical                         |
| `displayName`              | `displayName`              | identical                         |
| `description`              | `description`              | identical                         |
| `section`                  | `section`                  | identical                         |
| `maintainer`               | `maintainer`               | identical                         |
| `homepage`                 | `homepage`                 | identical                         |
| `license`                  | `license`                  | identical                         |
| `appStoreCategory`         | `appStoreCategory`         | identical                         |
| `appStoreType`             | `appStoreType`             | identical                         |
| `appStoreAuthor`           | `appStoreAuthor`           | identical                         |
| `appStoreTags`             | `appStoreTags`             | identical                         |
| `appStoreRepo`             | `appStoreRepo`             | identical                         |
| `appStoreMinServerVersion` | `appStoreMinServerVersion` | identical                         |
| `iconFile`                 | _(omitted — binary)_       | base64-encoded into the `.nipkg`  |
| `screenshotFiles`          | _(omitted — binary)_       | base64-encoded into the `.nipkg`  |
| `userVisible`, `tags`      | _(omitted)_                | nipkg-specific, not in manifest   |
| `buildDir`, `buildCommand` | _(omitted)_                | build settings only               |
| `depends`, `architecture`  | _(omitted)_                | build settings only               |
| _(derived)_                | `nipkgFile`                | filename added by publish tool    |

`slcli appstore publish <WEBAPP_DIR>` (and `sl-webapp-nipkg build`) should therefore
accept a `nipkg.config.json` as the single metadata source and emit both the `.nipkg`
and the `submissions/<package>/manifest.json` automatically, without requiring the
developer to maintain two files with divergent field names.



### 4.5 Add validation

In the `build` command, warn (or error) if `license` is missing, since REQUIREMENTS.md
marks it as required for App Store submissions.



## 5. Example: App Store `nipkg.config.json` for this project

How `webapp/nipkg.config.json` would look after the above changes. The metadata fields
are identical to [`submissions/systemlink-app-store/manifest.json`](../submissions/systemlink-app-store/manifest.json):

```json
{
  "package": "systemlink-app-store",
  "version": "0.1.0",
  "displayName": "SystemLink App Store",
  "description": "A curated marketplace webapp for discovering, installing, upgrading, and removing SystemLink web applications from a replicated package feed.",
  "section": "WebApps",
  "maintainer": "NI App Store <appstore@ni.com>",
  "homepage": "https://github.com/ni-kismet/systemlink-app-store",
  "license": "MIT",
  "appStoreCategory": "Administration",
  "appStoreType": "webapp",
  "appStoreAuthor": "NI",
  "appStoreTags": "app-store,catalog,packages,systemlink,webapp",
  "appStoreRepo": "https://github.com/ni-kismet/systemlink-app-store",
  "appStoreMinServerVersion": "2024 Q4",
  "iconFile": "public/icon.svg",

  "buildDir": "dist/webapp/browser",
  "buildCommand": "npm run build"
}
```

---

## 6. Summary of Required Changes

| #   | Type    | File                  | Change                                                                                                                                                              |
| --- | ------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bug fix | `src/types.ts`        | Implement `displayName` and `userVisible` properly — currently silently dropped by deboa                                                                            |
| 2   | Feature | `src/types.ts`        | Rename `packageName` → `package` to mirror `manifest.json`                                                                                                          |
| 3   | Feature | `src/types.ts`        | Add flat `section`, `homepage`, `license`, `appStoreCategory`, `appStoreType`, `appStoreAuthor`, `appStoreTags`, `appStoreRepo`, `appStoreMinServerVersion` fields  |
| 4   | Feature | `src/types.ts`        | Add `iconFile` and `screenshotFiles` (file paths — tool base64-encodes them); remove pre-base64 `icon`/`screenshots`                                                |
| 5   | Feature | `src/types.ts`        | Add `extraControlFields?: Record<string, string>` general escape hatch                                                                                              |
| 6   | Feature | `src/builder.ts`      | Implement `buildControlFileLines()` using flat config fields (fixes bugs #1.1 and #1.2)                                                                             |
| 7   | Feature | `src/builder.ts`      | Use `DeboaFromFile` for assembly (Option C) — bypasses deboa's control file generator entirely                                                                      |
| 8   | Feature | `src/builder.ts`      | Base64-encode `iconFile` / `screenshotFiles` during packaging via `encodeFileAsBase64()`                                                                            |
| 9   | Feature | `src/cli.ts`          | Update `init` command to output flat `nipkg.config.json` skeleton (mirrors `manifest.json` field names)                                                             |
| 10  | Feature | `src/cli.ts`          | Add `generate-manifest` subcommand: read `nipkg.config.json`, emit `manifest.json` (drop build fields, add `nipkgFile`)                                             |
| 11  | Feature | `src/builder.ts`      | Validate that `license` is present, warn if not (required for App Store)                                                                                            |
| 12  | Tests   | `src/builder.test.ts` | Test that all App Store fields appear verbatim in the generated control file                                                                                        |
