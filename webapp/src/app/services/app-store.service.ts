import { Injectable } from '@angular/core';
import {
  AppPackage,
  InstallManifest,
  InstalledApp,
  FEED_NAME,
  MANIFEST_TAG_PATH,
  WorkspaceInfo,
  WorkspaceInstallation,
  WorkspaceManifest,
} from '../models/app-store.models';

// ── SDK imports ───────────────────────────────────────────────
import { createClient as createFeedsClient, createConfig as createFeedsConfig } from 'nisystemlink-clients-ts/feeds/client';
import {
  getNifeedV1Feeds,
  getNifeedV1FeedsByFeedIdPackages,
  postNifeedV1ReplicateFeed,
  postNifeedV1FeedsByFeedIdCheckForUpdates,
  postNifeedV1FeedsByFeedIdApplyUpdates,
} from 'nisystemlink-clients-ts/feeds';
import type { Package } from 'nisystemlink-clients-ts/feeds';
import { createClient as createTagClient, createConfig as createTagConfig } from 'nisystemlink-clients-ts/tags/client';
import { createOrReplaceTagInWorkspace, updateTagCurrentValuesInWorkspace, getTagWithValueInWorkspace, queryTagsWithValues } from 'nisystemlink-clients-ts/tags';
import { createClient as createUserClient, createConfig as createUserConfig } from 'nisystemlink-clients-ts/user/client';
import { getWorkspaces } from 'nisystemlink-clients-ts/user';
import { createClient as createWebAppClient, createConfig as createWebAppConfig } from 'nisystemlink-clients-ts/web-application/client';
import { listWebapps as sdkListWebapps, createWebapp as sdkCreateWebapp, deleteWebapp as sdkDeleteWebapp } from 'nisystemlink-clients-ts/web-application';
import { compareSemver } from '../utils/semver';

@Injectable({ providedIn: 'root' })
export class AppStoreService {
  private origin = window.location.origin;

  // Each generated service has a different base URL path prefix burned into its spec.
  // For browser same-origin use we replace the spec's scheme+host with window.location.origin
  // and keep the spec's path prefix so generated operation paths resolve correctly.
  // feeds: spec base = https://dev-api.../  → urls include /nifeed/v1/...
  // file-ingestion: spec base = https://dev-api.../nifile → urls include /v1/service-groups/...
  // web-application: spec base = https://dev-api.../niapp/v1 → urls include /webapps
  private feedsClient = createFeedsClient(
    createFeedsConfig({ baseUrl: this.origin, credentials: 'include' })
  );
  private tagClient = createTagClient(
    createTagConfig({ baseUrl: `${this.origin}/nitag`, credentials: 'include' })
  );
  private userClient = createUserClient(
    createUserConfig({ baseUrl: `${this.origin}/niuser/v1`, credentials: 'include' })
  );
  private webAppClient = createWebAppClient(
    createWebAppConfig({ baseUrl: `${this.origin}/niapp/v1`, credentials: 'include' })
  );

  private workspacePromise: Promise<string> | null = null;

  // ── Feed Service ──────────────────────────────────────────────

  /** List all feeds and find the App Store feed by name. */
  async discoverFeed(): Promise<{ id: string; name: string } | null> {
    const { data, error } = await getNifeedV1Feeds({ client: this.feedsClient });
    if (error) throw new Error(`Failed to list feeds: ${JSON.stringify(error)}`);
    const feeds = data?.feeds ?? [];
    const feed = feeds.find(f => f.name === FEED_NAME);
    return feed?.id ? { id: feed.id, name: feed.name! } : null;
  }

  /** List all packages in a feed via the Feed Service packages API.
   * Reads first-class fields from metadata.* and custom App Store fields from
   * metadata.attributes, per the feed format spec. */
  async listPackages(feedId: string): Promise<AppPackage[]> {
    const { data, error } = await getNifeedV1FeedsByFeedIdPackages({
      client: this.feedsClient,
      path: { feedId },
    });
    if (error) throw new Error(`Failed to list packages: ${JSON.stringify(error)}`);

    const packages = (data?.packages ?? [])
      .filter(p => this.isUserVisibleWebappResource(p))
      .map(p => this.mapPackageResource(p));

    return this.selectLatestPackages(packages);
  }

  /** Download a package file (returns a Blob). */
  async downloadPackageFile(feedId: string, fileName: string): Promise<Blob> {
    const url = `${this.origin}/nifeed/v1/feeds/${encodeURIComponent(feedId)}/files/${encodeURIComponent(fileName)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    return res.blob();
  }

  /** Replicate a feed from a remote URL. */
  async replicateFeed(feedUrl: string): Promise<any> {
    const { data, error } = await postNifeedV1ReplicateFeed({
      client: this.feedsClient,
      body: {
        name: FEED_NAME,
        description: 'Curated marketplace for SystemLink apps',
        platform: 'WINDOWS',
        urls: [feedUrl],
      },
    });
    if (error) throw new Error(`Failed to replicate feed: ${JSON.stringify(error)}`);
    return data;
  }

  /** Trigger a check-for-updates job and poll until it completes.
   * Returns the list of pending-update resource IDs found (may be empty). */
  async checkForUpdates(feedId: string): Promise<string[]> {
    const { data, error } = await postNifeedV1FeedsByFeedIdCheckForUpdates({
      client: this.feedsClient,
      path: { feedId },
    });
    if (error) throw new Error(`Failed to check for updates: ${JSON.stringify(error)}`);
    const jobId = (data as any)?.jobId as string | undefined;
    if (!jobId) return [];

    // Poll jobs list until the CHECK_FEED_UPDATE job completes.
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const jobsRes = await fetch(
        `${this.origin}/nifeed/v1/feeds/${encodeURIComponent(feedId)}/jobs`,
        { credentials: 'include' },
      );
      if (!jobsRes.ok) continue;
      const jobsData = await jobsRes.json().catch(() => ({}));
      const job = (jobsData.jobs ?? []).find((j: any) => j.id === jobId);
      if (!job) continue;
      if (job.status === 'SUCCESS') return job.result?.resourceIds ?? [];
      if (job.status === 'FAILED' || job.status === 'ERROR') {
        throw new Error(`check-for-updates job failed: ${JSON.stringify(job.error)}`);
      }
    }
    throw new Error('check-for-updates job timed out');
  }

  /** Apply pending feed updates.
   * Reads the replicated Packages index (same-origin) to discover each
   * package's canonical upstream download URL, then calls apply-updates.
   * @param resourceIds  IDs returned by checkForUpdates; skip if empty. */
  async applyUpdates(feedId: string, resourceIds: string[]): Promise<void> {
    if (resourceIds.length === 0) return;

    // Fetch the replicated Packages index via same-origin (avoids CSP issues).
    const packagesUrl = `${this.origin}/nifeed/v1/feeds/${encodeURIComponent(feedId)}/files/Packages`;
    const indexRes = await fetch(packagesUrl, { credentials: 'include' });
    if (!indexRes.ok) throw new Error(`Failed to fetch replicated Packages index: HTTP ${indexRes.status}`);
    const indexText = await indexRes.text();
    const stanzas = this.parsePackagesIndex(indexText);
    const packageUris = stanzas
      .map(s => s['Filename'])
      .filter((uri): uri is string => !!uri && uri.startsWith('http'));
    if (packageUris.length === 0) throw new Error('No downloadable packages found in upstream index');

    // apply-updates: body is a flat object with applyUpdateDescriptors array.
    const res = await fetch(
      `${this.origin}/nifeed/v1/feeds/${encodeURIComponent(feedId)}/apply-updates`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applyUpdateDescriptors: packageUris.map(uri => ({ packageUri: uri })),
        }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Failed to apply updates: ${JSON.stringify(err)}`);
    }
  }

  // ── WebApp Service ────────────────────────────────────────────

  /** Resolve the workspace of the currently running webapp by reading the URL. */
  async getWorkspace(): Promise<string> {
    if (!this.workspacePromise) {
      this.workspacePromise = (async () => {
        try {
          const match = window.location.href.match(/\/webapps\/([0-9a-f-]{36})\/content/);
          if (!match) return '';
          const res = await fetch(`${this.origin}/niapp/v1/webapps/${match[1]}`, { credentials: 'include' });
          if (!res.ok) return '';
          const data = await res.json();
          return (data as any).workspace ?? '';
        } catch {
          return '';
        }
      })();
    }
    return this.workspacePromise;
  }

  /** Create a new webapp. Returns the created webapp (with id). */
  async createWebapp(name: string, workspace: string): Promise<any> {
    const { data, error } = await sdkCreateWebapp({
      client: this.webAppClient,
      body: { name, workspace, policyIds: [] },
    });
    if (error) throw new Error(`Failed to create webapp: ${JSON.stringify(error)}`);
    return data;
  }

  /** Upload .nipkg content to a webapp. */
  async uploadContent(webappId: string, nipkgBlob: Blob): Promise<void> {
    const url = `${this.origin}/niapp/v1/webapps/${encodeURIComponent(webappId)}/content`;
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      body: nipkgBlob,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }

  /** Delete a webapp. */
  async deleteWebapp(webappId: string): Promise<void> {
    const { error } = await sdkDeleteWebapp({
      client: this.webAppClient,
      path: { id: webappId },
    });
    if (error) throw new Error(`Failed to delete webapp: ${JSON.stringify(error)}`);
  }

  /** List webapps (to check permissions). */
  async listWebapps(): Promise<any> {
    const { data, error } = await sdkListWebapps({
      client: this.webAppClient,
      query: { take: 1 } as any,
    });
    if (error) throw new Error(`Failed to list webapps: ${JSON.stringify(error)}`);
    return data;
  }

  /** List workspaces the current user can read. */
  async listReadableWorkspaces(): Promise<WorkspaceInfo[]> {
    const { data, error } = await getWorkspaces({ client: this.userClient });
    if (error) throw new Error(`Failed to list workspaces: ${JSON.stringify(error)}`);

    return (data?.workspaces ?? [])
      .filter((workspace): workspace is { id: string; name?: string } => !!workspace?.id)
      .map(workspace => ({
        id: workspace.id,
        name: workspace.name?.trim() || workspace.id,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  // ── Tag Service (manifest) ────────────────────────────────────

  /**
   * Find the install manifest stored as a STRING tag in the Tag Service.
   * Returns null if the tag does not exist or has no value yet.
   */
  async findManifest(workspace?: string): Promise<InstallManifest | null> {
    if (!workspace) {
      workspace = await this.getWorkspace() || undefined;
    }
    if (!workspace) return null;

    const { data, error } = await getTagWithValueInWorkspace({
      client: this.tagClient,
      path: { workspace, path: MANIFEST_TAG_PATH },
    });
    if (error || !data?.current?.value?.value) return null;
    return this.parseManifestValue(data.current.value.value);
  }

  /** List all readable workspace manifests for the well-known App Store tag path. */
  async listWorkspaceManifests(): Promise<WorkspaceManifest[]> {
    const currentWorkspace = await this.getWorkspace();
    let workspaces: WorkspaceInfo[] = [];

    try {
      workspaces = await this.listReadableWorkspaces();
    } catch {
      workspaces = [];
    }

    const workspaceNames = new Map(workspaces.map(workspace => [workspace.id, workspace.name]));
    const manifests = new Map<string, WorkspaceManifest>();

    try {
      const { data, error } = await queryTagsWithValues({
        client: this.tagClient,
        body: {
          filter: `path = "${MANIFEST_TAG_PATH}"`,
          take: 1000,
          orderBy: 'PATH',
        } as any,
      });
      if (error) throw new Error(JSON.stringify(error));

      for (const tagWithValue of data?.tagsWithValues ?? []) {
        const workspaceId = tagWithValue.tag?.workspace?.trim();
        const manifest = this.parseManifestValue(tagWithValue.current?.value?.value);
        if (!workspaceId || !manifest) {
          continue;
        }

        manifests.set(workspaceId, {
          workspaceId,
          workspaceName: workspaceNames.get(workspaceId) ?? workspaceId,
          isCurrentWorkspace: workspaceId === currentWorkspace,
          manifest,
        });
      }
    } catch {
      // Fall back to the current workspace manifest below.
    }

    if (currentWorkspace && !manifests.has(currentWorkspace)) {
      const manifest = await this.findManifest(currentWorkspace);
      if (manifest) {
        manifests.set(currentWorkspace, {
          workspaceId: currentWorkspace,
          workspaceName: workspaceNames.get(currentWorkspace) ?? currentWorkspace,
          isCurrentWorkspace: true,
          manifest,
        });
      }
    }

    return [...manifests.values()].sort((left, right) => {
      if (left.isCurrentWorkspace !== right.isCurrentWorkspace) {
        return left.isCurrentWorkspace ? -1 : 1;
      }

      return left.workspaceName.localeCompare(right.workspaceName) || left.workspaceId.localeCompare(right.workspaceId);
    });
  }

  /**
   * Persist the manifest to the Tag Service (create or update).
   * Uses createOrReplaceTagInWorkspace to upsert the tag metadata,
   * then writes the JSON-serialised manifest as the current value.
   */
  async saveManifest(manifest: InstallManifest, workspace?: string): Promise<void> {
    workspace = workspace ?? await this.getWorkspace();
    if (!workspace) throw new Error('Cannot save manifest: workspace unknown');

    // Upsert the tag metadata (idempotent PUT)
    const { error: tagError } = await createOrReplaceTagInWorkspace({
      client: this.tagClient,
      path: { workspace, path: MANIFEST_TAG_PATH },
      body: { path: MANIFEST_TAG_PATH, type: 'STRING', workspace },
    });
    if (tagError) throw new Error(`Failed to create manifest tag: ${JSON.stringify(tagError)}`);

    // Write the JSON-serialised manifest as the current value
    const { error: valueError } = await updateTagCurrentValuesInWorkspace({
      client: this.tagClient,
      path: { workspace, path: MANIFEST_TAG_PATH },
      body: { value: { value: JSON.stringify(manifest), type: 'STRING' } },
    });
    if (valueError) throw new Error(`Failed to write manifest tag value: ${JSON.stringify(valueError)}`);
  }

  // ── Install / Upgrade / Uninstall ─────────────────────────────

  /** Install a package into a workspace. */
  async installApp(
    feedId: string,
    pkg: AppPackage,
    manifest: InstallManifest,
    workspace?: string,
  ): Promise<InstallManifest> {
    // 1. Resolve workspace and download .nipkg in parallel
    const [resolvedWorkspace, nipkgBlob] = await Promise.all([
      workspace ? Promise.resolve(workspace) : this.getWorkspace(),
      this.downloadPackageFile(feedId, this.extractFileName(pkg.filename)),
    ]);
    if (!resolvedWorkspace) throw new Error('Cannot install app: workspace unknown');

    // 2. Create webapp
    const webapp = await this.createWebapp(pkg.displayName, resolvedWorkspace);

    // 3. Upload .nipkg content
    await this.uploadContent(webapp.id, nipkgBlob);

    // 4. Update manifest
    const now = new Date().toISOString();
    manifest.installedApps[pkg.packageName] = {
      version: pkg.version,
      type: pkg.type,
      webappId: webapp.id,
      installedAt: now,
      updatedAt: null,
    };
    await this.saveManifest(manifest, resolvedWorkspace);

    return manifest;
  }

  /** Install a package into one or more workspaces, downloading the .nipkg once. */
  async installAppAcrossWorkspaces(
    feedId: string,
    pkg: AppPackage,
    workspaces: string[],
    workspaceManifests: WorkspaceManifest[],
    sourceUrl?: string,
  ): Promise<void> {
    if (workspaces.length === 0) {
      return;
    }

    const fileName = this.extractFileName(pkg.filename);
    const nipkgBlob = await this.downloadPackageFile(feedId, fileName);

    for (const workspace of workspaces) {
      const manifest = this.cloneManifest(
        workspaceManifests.find(workspaceManifest => workspaceManifest.workspaceId === workspace)?.manifest ?? null
      ) ?? this.createEmptyManifest(feedId, sourceUrl);

      if (manifest.installedApps[pkg.packageName]) {
        throw new Error(`Package ${pkg.packageName} is already installed in workspace ${workspace}`);
      }

      const webapp = await this.createWebapp(pkg.displayName, workspace);
      await this.uploadContent(webapp.id, nipkgBlob);

      const now = new Date().toISOString();
      manifest.installedApps[pkg.packageName] = {
        version: pkg.version,
        type: pkg.type,
        webappId: webapp.id,
        installedAt: now,
        updatedAt: null,
      };

      await this.saveManifest(manifest, workspace);
    }
  }

  /** Upgrade an installed app to a new version. */
  async upgradeApp(
    feedId: string,
    pkg: AppPackage,
    installed: InstalledApp,
    manifest: InstallManifest,
    workspace?: string,
  ): Promise<InstallManifest> {
    // 1. Download new .nipkg
    const fileName = this.extractFileName(pkg.filename);
    const nipkgBlob = await this.downloadPackageFile(feedId, fileName);

    // 2. Upload to existing webapp
    await this.uploadContent(installed.webappId, nipkgBlob);

    // 3. Update manifest
    manifest.installedApps[pkg.packageName] = {
      ...installed,
      version: pkg.version,
      updatedAt: new Date().toISOString(),
    };
    await this.saveManifest(manifest, workspace);

    return manifest;
  }

  /** Uninstall an app from a workspace. */
  async uninstallApp(
    packageName: string,
    installed: InstalledApp,
    manifest: InstallManifest,
    workspace?: string,
  ): Promise<InstallManifest> {
    await this.deleteWebapp(installed.webappId);
    delete manifest.installedApps[packageName];
    await this.saveManifest(manifest, workspace);
    return manifest;
  }

  /** Upgrade every readable workspace installation of a package to the catalog version. */
  async upgradeAppAcrossWorkspaces(
    feedId: string,
    pkg: AppPackage,
    installations: WorkspaceInstallation[],
    workspaceManifests: WorkspaceManifest[],
  ): Promise<void> {
    const fileName = this.extractFileName(pkg.filename);
    const nipkgBlob = await this.downloadPackageFile(feedId, fileName);

    for (const installation of installations) {
      await this.uploadContent(installation.webappId, nipkgBlob);

      const manifest = this.cloneManifest(
        workspaceManifests.find(workspaceManifest => workspaceManifest.workspaceId === installation.workspaceId)?.manifest
          ?? await this.findManifest(installation.workspaceId)
      );

      if (!manifest || !manifest.installedApps[pkg.packageName]) {
        throw new Error(`Manifest entry for ${pkg.packageName} not found in workspace ${installation.workspaceName}`);
      }

      manifest.installedApps[pkg.packageName] = {
        ...manifest.installedApps[pkg.packageName],
        version: pkg.version,
        updatedAt: new Date().toISOString(),
      };

      await this.saveManifest(manifest, installation.workspaceId);
    }
  }

  /** Uninstall a package from every readable workspace where it is currently installed. */
  async uninstallAppAcrossWorkspaces(
    packageName: string,
    installations: WorkspaceInstallation[],
    workspaceManifests: WorkspaceManifest[],
  ): Promise<void> {
    for (const installation of installations) {
      await this.deleteWebapp(installation.webappId);

      const manifest = this.cloneManifest(
        workspaceManifests.find(workspaceManifest => workspaceManifest.workspaceId === installation.workspaceId)?.manifest
          ?? await this.findManifest(installation.workspaceId)
      );

      if (!manifest) {
        throw new Error(`Manifest for workspace ${installation.workspaceName} not found`);
      }

      delete manifest.installedApps[packageName];
      await this.saveManifest(manifest, installation.workspaceId);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.origin}${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /** Parse an RFC 822-style Packages index into an array of field maps. */
  private parsePackagesIndex(text: string): Record<string, string>[] {
    const normalizedText = text.replace(/\r\n?/g, '\n');

    return normalizedText.split(/\n[\t ]*\n+/).filter(s => s.trim()).map(stanza => {
      const fields: Record<string, string> = {};
      let key: string | null = null;
      for (const line of stanza.split('\n')) {
        if ((line.startsWith(' ') || line.startsWith('\t')) && key) {
          fields[key] += '\n' + line.slice(1);
        } else {
          const colon = line.indexOf(':');
          if (colon > 0) {
            key = line.substring(0, colon).trim();
            fields[key] = line.substring(colon + 1).trim();
          }
        }
      }
      return fields;
    });
  }

  /** Map a Feed Service Package resource to an AppPackage.
   * First-class fields come from metadata.*, custom App Store fields from metadata.attributes. */
  private mapPackageResource(pkg: Package): AppPackage {
    const m = pkg.metadata ?? {};
    const attrs = m.attributes ?? {};
    return {
      packageName: m.packageName ?? '',
      version: m.version ?? attrs['DisplayVersion'] ?? '',
      displayName: attrs['DisplayName'] ?? m.packageName ?? '',
      description: m.description ?? '',
      section: m.section ?? '',
      maintainer: m.maintainer ?? '',
      homepage: m.homepage ?? '',
      icon: attrs['AppStoreIcon'] ?? '',
      screenshots: [
        attrs['AppStoreScreenshot1'],
        attrs['AppStoreScreenshot2'],
        attrs['AppStoreScreenshot3'],
      ].filter((v): v is string => !!v),
      category: attrs['AppStoreCategory'] ?? '',
      type: attrs['AppStoreType'] ?? 'webapp',
      author: attrs['AppStoreAuthor'] ?? '',
      license: attrs['AppStoreLicense'] ?? '',
      tags: m.tags ?? attrs['AppStoreTags'] ?? '',
      repo: attrs['AppStoreRepo'] ?? m.homepage ?? '',
      minServerVersion: attrs['AppStoreMinServerVersion'] ?? '',
      size: m.size ?? 0,
      sha256: attrs['SHA256'] ?? '',
      filename: m.fileName ?? '',
      feedPackageId: pkg.id ?? undefined,
    };
  }

  private isUserVisibleWebappResource(pkg: Package): boolean {
    const attrs = pkg.metadata?.attributes ?? {};
    if (attrs['UserVisible'] === 'no') return false;
    const packageType = attrs['AppStoreType']?.trim().toLowerCase();
    if (packageType) return packageType === 'webapp';
    return (pkg.metadata?.section ?? '').trim() === 'WebApps';
  }

  private selectLatestPackages(packages: AppPackage[]): AppPackage[] {
    const latestPackages = new Map<string, AppPackage>();

    for (const pkg of packages) {
      const existing = latestPackages.get(pkg.packageName);
      if (!existing || compareSemver(pkg.version, existing.version) > 0) {
        latestPackages.set(pkg.packageName, pkg);
      }
    }

    return [...latestPackages.values()].sort(
      (left, right) => left.displayName.localeCompare(right.displayName) || left.packageName.localeCompare(right.packageName)
    );
  }

  private extractFileName(filenameOrUrl: string): string {
    // The Filename field may be a full URL or just a filename
    try {
      const url = new URL(filenameOrUrl);
      return url.pathname.split('/').pop() ?? filenameOrUrl;
    } catch {
      return filenameOrUrl;
    }
  }

  private parseManifestValue(value: unknown): InstallManifest | null {
    if (typeof value !== 'string') {
      return null;
    }

    try {
      const manifest = JSON.parse(value) as InstallManifest;
      if (!manifest?.config?.feedName || !manifest?.installedApps) {
        return null;
      }

      return manifest;
    } catch {
      return null;
    }
  }

  private cloneManifest(manifest: InstallManifest | null): InstallManifest | null {
    if (!manifest) {
      return null;
    }

    return {
      ...manifest,
      config: { ...manifest.config },
      installedApps: { ...manifest.installedApps },
    };
  }

  /** Create a default empty manifest. */
  createEmptyManifest(feedId: string, sourceUrl?: string): InstallManifest {
    return {
      version: 1,
      config: {
        feedName: FEED_NAME,
        feedId,
        ...(sourceUrl ? { sourceUrl } : {}),
      },
      installedApps: {},
    };
  }
}
