# Manifest Changes Required in `slcli` and `sl-webapp-nipkg`

This document describes the manifest contract that external tooling must support after the rename from SystemLink App Store to Plugin Manager for SystemLink.

The goal is narrow: `slcli` and `@ni-kismet/sl-webapp-nipkg` must be able to generate:

- a submission manifest that passes this repository's [`app-manifest.schema.json`](../app-manifest.schema.json)
- a `.nipkg` whose metadata can be translated into a valid `Packages` stanza for the Plugin Manager feed

## Scope

There are two related but distinct artifacts:

1. Submission manifest
   This is the `manifest.json` committed under `submissions/<package>/` and validated by CI in this repository.

2. Packaging config / nipkg metadata
   This is the input consumed by `sl-webapp-nipkg` to create the `.nipkg`. It should use the same metadata fields as the submission manifest, with a few packager-only additions such as `buildDir` and `iconFile`.

## Implemented Submission Contract: Thin Manifest

Yes. This repository can support a thinner `manifest.json` if it treats the `.nipkg` control metadata as the canonical source of package metadata and treats the submission manifest as a provenance and review artifact only.

That split is cleaner because the following fields already belong in the package itself and should not need to be duplicated in the submission manifest:

- `package`
- `version`
- `displayName`
- `description`
- `section`
- `maintainer`
- `homepage`
- `license`
- `xbPlugin`
- `slPluginManagerTags`
- `slPluginManagerMinServerVersion`
- `iconFile` when the icon is already embedded into `XB-SlPluginManagerIcon`

### Proposed thin manifest contract

Recommended minimal shape:

```json
{
  "schemaVersion": 2,
  "nipkgFile": "my-plugin_1.2.3_all.nipkg",
  "sha256": "7b7f5d9c2d6e4d6f8d89b3a5b1f7dbe4b9f6b61f4c3b98b1e2f8d0a4c6d8e1f2",
  "sourceRepo": "yourorg/your-repo",
  "releaseTag": "my-plugin-v1.2.3",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567"
}
```

Required fields:

- `schemaVersion`
- `nipkgFile`
- `sha256`

Strongly recommended fields:

- `sourceRepo`
- `releaseTag`
- `sourceCommit`

Optional fields:

- future provenance fields such as an attestation, SBOM, or reviewer notes

### What still belongs outside the package

The submission manifest should keep only data that the `.nipkg` should not be responsible for or cannot safely represent on its own:

- artifact location within the submission directory (`nipkgFile`)
- integrity binding for the reviewed artifact (`sha256`)
- publication provenance (`sourceRepo`, `releaseTag`, `sourceCommit`)
- optional supply-chain artifacts such as attestations or SBOM references

This gives the review process a stable object to validate without forcing metadata drift between the submission JSON and the package control file.

### Repository changes required for the thin manifest flow

To make this work, the repository needs to stop treating `manifest.json` as the canonical metadata source.

1. `scripts/rebuild_index.py` should extract control metadata directly from the `.nipkg`.
  It should read the package control file and derive `Package`, `Version`, `Description`, `Section`, `Maintainer`, `Homepage`, `XB-DisplayName`, `XB-Plugin`, and `XB-SlPluginManager*` fields from the archive itself. The submission manifest should only provide the artifact path, integrity hash, and provenance.

2. `.github/workflows/validate-submission.yml` should validate the submitted artifact, not duplicate JSON.
  The workflow should verify that `sha256` matches the referenced `.nipkg`, inspect the archive structure, extract control metadata, and validate that the package contains the required Plugin Manager metadata. Schema validation should move from package metadata fields to the thin submission manifest fields.

3. `scripts/submit_package.py` should branch and create PRs from package metadata.
  For local and cross-repo submissions, it should resolve the `.nipkg`, verify the declared hash, extract package metadata from the archive, and use that metadata for the branch name, commit message, and PR title/body.

4. `.github/workflows/publish-release.yml` should read release naming data from the `.nipkg`.
  Package name, version, and display name should come from extracted control metadata rather than from `manifest.json`.

5. External publishing workflows should dispatch a thin manifest.
  The example publisher should compute the SHA after packaging, attach the `.nipkg` to the source release, and dispatch only the thin manifest plus release coordinates.

### Review and security implications

This approach improves the process rather than weakening it, as long as the hash becomes mandatory and the repo validates the package contents before merge:

- there is one canonical metadata source for the catalog: the `.nipkg`
- reviewers approve the exact bytes identified by `sha256`
- release automation can verify that the artifact uploaded to GitHub Releases is the same artifact reviewed in the PR
- metadata drift between `manifest.json`, `nipkg.config.json`, and the control file goes away

The main tradeoff is implementation work: the repo needs a reliable control-file extraction path and a backward-compatible migration period.

## New canonical manifest contract

The submission manifest now carries only artifact identity and provenance. Package metadata is derived from the `.nipkg` control file.

Required fields are:

```json
{
  "schemaVersion": 2,
  "nipkgFile": "my-plugin_1.2.3_all.nipkg",
  "sha256": "7b7f5d9c2d6e4d6f8d89b3a5b1f7dbe4b9f6b61f4c3b98b1e2f8d0a4c6d8e1f2",
  "sourceRepo": "yourorg/my-plugin",
  "releaseTag": "my-plugin-v1.2.3",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567"
}
```

Required fields:

- `schemaVersion`
- `nipkgFile`
- `sha256`

Optional fields:

- `sourceRepo`
- `releaseTag`
- `sourceCommit`

### Canonical package metadata source

The package itself must now carry the Plugin Manager metadata used by the catalog.

Expected behavior:

- `rebuild_index.py` reads package metadata from the `.nipkg` control file
- `validate-submission.yml` verifies the manifest hash and inspects the `.nipkg`
- `submit_package.py` derives package name, version, and display name from the `.nipkg`
- `publish-release.yml` names releases from the `.nipkg`
- `XB-SlPluginManagerIcon` must be embedded in the package; it is no longer referenced through `iconFile` in the submission manifest

## Field migration from the old App Store contract

The old manifest shape used App Store-specific fields. Tooling should stop emitting those fields for new packages.

| Old field                  | New field / behavior                           |
| -------------------------- | ---------------------------------------------- |
| `appStoreCategory`         | Replace with `section`                         |
| `appStoreType`             | Replace with `xbPlugin`                        |
| `appStoreAuthor`           | Replace with `maintainer`                      |
| `appStoreRepo`             | Replace with `homepage`                        |
| `appStoreTags`             | Replace with `slPluginManagerTags`             |
| `appStoreMinServerVersion` | Replace with `slPluginManagerMinServerVersion` |

Fields that should no longer be generated in new manifests:

- `appStoreCategory`
- `appStoreType`
- `appStoreAuthor`
- `appStoreRepo`
- `appStoreTags`
- `appStoreMinServerVersion`

## Meaning of the new fields

### `section`

`section` is now the fine-grained user-facing category shown in the catalog.

Examples:

- `Dashboard`
- `Data Analysis`
- `Administration`
- `Monitoring`
- `Integration`

This is no longer a top-level resource type bucket like `WebApps` or `Notebooks`.

### `xbPlugin`

`xbPlugin` is now the top-level plugin type. Allowed values currently match the schema:

- `webapp`
- `notebook`
- `dashboard`
- `routine`
- `bundle`

This value is written into the feed as `XB-Plugin` and is used by the Plugin Manager runtime for routing and filtering.

### `maintainer`

`maintainer` replaces `appStoreAuthor` as the canonical author source.

Expected format:

```text
Name <email@example.com>
```

The Plugin Manager UI derives the display author name from the `maintainer` string.

### `homepage`

`homepage` replaces `appStoreRepo`.

It can point at a source repository, documentation site, or project homepage. Tooling should not require it to be specifically a GitHub repository URL.

### `slPluginManager*` fields

All Plugin Manager-specific extension fields now use the `slPluginManager` prefix.

Current fields:

- `slPluginManagerTags`
- `slPluginManagerMinServerVersion`

Future Plugin Manager-specific manifest fields should use the same prefix.

## What `slcli` needs to change

`slcli plugin-manager publish` should generate manifests and packaging inputs using the new field names.

### Required output changes

When `slcli` creates a manifest, it should:

- write `section`, not `appStoreCategory`
- write `xbPlugin`, not `appStoreType`
- write `maintainer`, not `appStoreAuthor`
- write `homepage`, not `appStoreRepo`
- write `slPluginManagerTags`, not `appStoreTags`
- write `slPluginManagerMinServerVersion`, not `appStoreMinServerVersion`
- write `iconFile` so the package icon is explicit in the manifest

### CLI flag mapping

If the CLI still exposes older option names internally or for compatibility, the produced manifest should still use the new keys.

Recommended mapping:

| CLI concept         | Manifest field                    |
| ------------------- | --------------------------------- |
| package name        | `package`                         |
| version             | `version`                         |
| display name        | `displayName`                     |
| description         | `description`                     |
| category            | `section`                         |
| maintainer / author | `maintainer`                      |
| homepage / repo     | `homepage`                        |
| license             | `license`                         |
| plugin type         | `xbPlugin`                        |
| tags                | `slPluginManagerTags`             |
| min server version  | `slPluginManagerMinServerVersion` |
| icon asset path     | `iconFile`                        |

### `nipkgFile`

When `slcli` also writes the `.nipkg` into the submission directory, it should set:

```json
"nipkgFile": "<package>_<version>_all.nipkg"
```

That makes submission validation deterministic and avoids relying on directory scans.

### Validation expectations for `slcli`

Before writing a manifest, `slcli` should validate that:

- `version` is strict semver: `MAJOR.MINOR.PATCH`
- `description` is at least 20 characters
- `package` is lowercase and matches `^[a-z0-9][a-z0-9._-]*$`
- `section` is at least 2 characters
- `xbPlugin` is one of the allowed schema values
- `maintainer` is present and formatted as `Name <email>`
- `iconFile` exists and points at a valid icon asset

## What `sl-webapp-nipkg` needs to change

`@ni-kismet/sl-webapp-nipkg` should accept the same metadata contract used by the submission manifest, plus packager-only fields.

Current repo example:

```json
{
  "package": "systemlink-plugin-manager",
  "version": "0.2.2",
  "displayName": "Plugin Manager for SystemLink",
  "description": "A curated plugin manager for discovering, installing, upgrading, and removing SystemLink extensions from replicated package feeds.",
  "section": "Administration",
  "maintainer": "NI Plugin Manager <appstore@ni.com>",
  "homepage": "https://github.com/ni-kismet/systemlink-plugin-manager",
  "license": "MIT",
  "xbPlugin": "webapp",
  "slPluginManagerTags": "plugin-manager,catalog,packages,systemlink,webapp",
  "slPluginManagerMinServerVersion": "2024 Q4",
  "iconFile": "../submissions/systemlink-plugin-manager/icon.svg",
  "buildDir": "dist/webapp/browser",
  "buildCommand": "npm run build"
}
```

### Input contract changes

The packager should accept these metadata keys directly:

- `section`
- `maintainer`
- `homepage`
- `license`
- `xbPlugin`
- `slPluginManagerTags`
- `slPluginManagerMinServerVersion`
- `iconFile`

It should no longer require or emit App Store-specific keys.

### Control-file metadata changes

To create a valid Plugin Manager package, `sl-webapp-nipkg` should write the following control-file fields:

| Manifest/config field             | Control-file field                   |
| --------------------------------- | ------------------------------------ |
| `package`                         | `Package`                            |
| `version`                         | `Version`                            |
| inferred architecture             | `Architecture: all`                  |
| `description`                     | `Description`                        |
| `section`                         | `Section`                            |
| `maintainer`                      | `Maintainer`                         |
| `homepage`                        | `Homepage`                           |
| `displayName`                     | `XB-DisplayName`                     |
| `version`                         | `XB-DisplayVersion`                  |
| `xbPlugin`                        | `XB-Plugin`                          |
| package visibility default        | `XB-UserVisible: yes`                |
| `license`                         | `XB-SlPluginManagerLicense`          |
| `slPluginManagerTags`             | `XB-SlPluginManagerTags`             |
| `slPluginManagerMinServerVersion` | `XB-SlPluginManagerMinServerVersion` |
| `iconFile`                        | `XB-SlPluginManagerIcon`             |

### Important note about `XB-Plugin`

This repo now treats `XB-Plugin` as the plugin resource type, not as the old App Store category/type hybrid.

That means:

- `XB-Plugin: webapp` is valid for a web application package
- `XB-Plugin: notebook` is valid for a notebook package
- `XB-Plugin: dashboard` is valid for a dashboard package

The packager should not derive `XB-Plugin` from `section`.

### Icon

The packager should embed `XB-SlPluginManagerIcon` into the `.nipkg` using `iconFile`.

That keeps the package self-describing and allows downstream tooling to recover the icon without depending on a separate submission directory convention.

The feed index builder should continue to support submission-directory icon files, but the package build plan should treat icon embedding as part of the packaging contract.

## Compatibility guidance

If either tool still needs to ingest older manifests during transition, compatibility should be read-only.

Recommended behavior:

- accept old App Store field names as legacy input only
- normalize them into the new Plugin Manager field names internally
- always write the new field names when generating output

In other words, compatibility should be lenient on input and strict on output.

## Minimum valid output examples

### Submission manifest generated by `slcli`

```json
{
  "package": "my-awesome-dashboard",
  "version": "1.0.0",
  "displayName": "My Awesome Dashboard",
  "description": "A dashboard for monitoring asset health and calibration status across your SystemLink fleet.",
  "section": "Dashboard",
  "maintainer": "Your Name <you@example.com>",
  "homepage": "https://github.com/yourorg/my-awesome-dashboard",
  "license": "MIT",
  "xbPlugin": "webapp",
  "slPluginManagerTags": "assets,calibration,dashboard,monitoring",
  "slPluginManagerMinServerVersion": "2024 Q4",
  "iconFile": "icon.svg",
  "nipkgFile": "my-awesome-dashboard_1.0.0_all.nipkg"
}
```

### NIPKG config accepted by `sl-webapp-nipkg`

```json
{
  "package": "my-awesome-dashboard",
  "version": "1.0.0",
  "displayName": "My Awesome Dashboard",
  "description": "A dashboard for monitoring asset health and calibration status across your SystemLink fleet.",
  "section": "Dashboard",
  "maintainer": "Your Name <you@example.com>",
  "homepage": "https://github.com/yourorg/my-awesome-dashboard",
  "license": "MIT",
  "xbPlugin": "webapp",
  "slPluginManagerTags": "assets,calibration,dashboard,monitoring",
  "slPluginManagerMinServerVersion": "2024 Q4",
  "iconFile": "icon.svg",
  "buildDir": "dist/browser",
  "buildCommand": "npm run build"
}
```

## Acceptance criteria for the tooling updates

The changes in `slcli` and `sl-webapp-nipkg` are sufficient when all of the following are true:

- generated manifests validate against [`app-manifest.schema.json`](../app-manifest.schema.json)
- generated manifests contain no `appStore*` keys
- generated manifests include `iconFile` and that file exists
- generated package metadata maps cleanly to the `Packages` stanza produced by [`scripts/rebuild_index.py`](../scripts/rebuild_index.py)
- generated packages can participate in release URLs of the form:

```text
https://github.com/<org>/<repo>/releases/download/<package>-v<version>/<package>_<version>_all.nipkg
```

- the resulting feed exposes `XB-Plugin` and `XB-SlPluginManager*` metadata, not `XB-AppStore*`
- the resulting `.nipkg` embeds `XB-SlPluginManagerIcon`

## Repository references

The current examples in this repo are:

- schema: [`app-manifest.schema.json`](../app-manifest.schema.json)
- submission manifest: [`submissions/systemlink-plugin-manager/manifest.json`](../submissions/systemlink-plugin-manager/manifest.json)
- webapp packager config: [`webapp/nipkg.config.json`](../webapp/nipkg.config.json)
- index builder: [`scripts/rebuild_index.py`](../scripts/rebuild_index.py)
