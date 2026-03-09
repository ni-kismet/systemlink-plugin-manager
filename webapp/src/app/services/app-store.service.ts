import { Injectable } from '@angular/core';
import {
  AppPackage,
  InstallManifest,
  InstalledApp,
  DEFAULT_FEED_URL,
  FEED_NAME,
  MANIFEST_FILE_NAME,
  MANIFEST_FILE_PROPERTIES,
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
import { createClient as createFileClient, createConfig as createFileConfig } from 'nisystemlink-clients-ts/file-ingestion/client';
import { upload, delete_ as deleteFile } from 'nisystemlink-clients-ts/file-ingestion';
import { createClient as createWebAppClient, createConfig as createWebAppConfig } from 'nisystemlink-clients-ts/web-application/client';
import { listWebapps as sdkListWebapps, createWebapp as sdkCreateWebapp, deleteWebapp as sdkDeleteWebapp } from 'nisystemlink-clients-ts/web-application';

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
  private fileClient = createFileClient(
    createFileConfig({ baseUrl: `${this.origin}/nifile`, credentials: 'include' })
  );
  private webAppClient = createWebAppClient(
    createWebAppConfig({ baseUrl: `${this.origin}/niapp/v1`, credentials: 'include' })
  );

  // ── Feed Service ──────────────────────────────────────────────

  /** List all feeds and find the App Store feed by name. */
  async discoverFeed(): Promise<{ id: string; name: string } | null> {
    const { data, error } = await getNifeedV1Feeds({ client: this.feedsClient });
    if (error) throw new Error(`Failed to list feeds: ${JSON.stringify(error)}`);
    const feeds = data?.feeds ?? [];
    const feed = feeds.find(f => f.name === FEED_NAME);
    return feed?.id ? { id: feed.id, name: feed.name! } : null;
  }

  /** List all packages in a feed. */
  async listPackages(feedId: string): Promise<AppPackage[]> {
    const { data, error } = await getNifeedV1FeedsByFeedIdPackages({
      client: this.feedsClient,
      path: { feedId },
    });
    if (error) throw new Error(`Failed to list packages: ${JSON.stringify(error)}`);
    const packages = data?.packages ?? [];
    return packages
      .filter(p => (p as any).userVisible !== false)
      .map(p => this.mapPackage(p));
  }

  /** Get a single package by its feed-level package ID. */
  async getPackage(packageId: string): Promise<AppPackage> {
    const res = await this.get(`/nifeed/v1/packages/${encodeURIComponent(packageId)}`);
    return this.mapPackage(res);
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

  /** Check for feed updates. */
  async checkForUpdates(feedId: string): Promise<any> {
    const { data, error } = await postNifeedV1FeedsByFeedIdCheckForUpdates({
      client: this.feedsClient,
      path: { feedId },
    });
    if (error) throw new Error(`Failed to check for updates: ${JSON.stringify(error)}`);
    return data;
  }

  /** Apply pending feed updates. */
  async applyUpdates(feedId: string): Promise<any> {
    const { data, error } = await postNifeedV1FeedsByFeedIdApplyUpdates({
      client: this.feedsClient,
      path: { feedId },
      body: {},
    });
    if (error) throw new Error(`Failed to apply updates: ${JSON.stringify(error)}`);
    return data;
  }

  // ── WebApp Service ────────────────────────────────────────────

  /** Create a new webapp. Returns the created webapp (with id). */
  async createWebapp(name: string, workspace: string): Promise<any> {
    const { data, error } = await sdkCreateWebapp({
      client: this.webAppClient,
      body: { name, workspace },
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

  // ── File Service (manifest) ───────────────────────────────────

  private readonly MANIFEST_CACHE_KEY = 'appstore_manifest_file_id';

  /**
   * Find the install manifest file.
   * Uses localStorage to cache the file ID across sessions.
   *
   * Note: POST /query-files with propertiesQuery reliably times out for custom (un-indexed)
   * properties per the File Service spec. Instead we list all files (GET /files) and filter
   * the `properties` map client-side — the metadata is returned inline so no extra downloads.
   */
  async findManifest(workspace?: string): Promise<{ fileId: string; manifest: InstallManifest } | null> {
    // Fast path: cached file ID from a previous session
    const cachedId = localStorage.getItem(this.MANIFEST_CACHE_KEY);
    if (cachedId) {
      const manifest = await this.downloadManifest(cachedId);
      if (manifest?.config?.feedName) {
        return { fileId: cachedId, manifest };
      }
      // Cache stale (file deleted or moved) — fall through to full search
      localStorage.removeItem(this.MANIFEST_CACHE_KEY);
    }

    // List all files sorted most-recently-updated first and filter properties client-side.
    // The structured /query-files propertiesQuery times out on un-indexed custom properties.
    const params = new URLSearchParams({
      take: '1000',
      orderBy: 'lastUpdatedTimestamp',
      orderByDescending: 'true',
      ...(workspace ? { workspace } : {}),
    });
    const res = await fetch(
      `${this.origin}/nifile/v1/service-groups/Default/files?${params}`,
      { credentials: 'include' },
    );
    if (!res.ok) {
      console.warn('Failed to list files for manifest search:', res.status);
      return null;
    }
    const listData = await res.json();
    for (const file of listData?.availableFiles ?? []) {
      if (!file.id || file.properties?.['appstore'] !== 'manifest') continue;
      const manifest = await this.downloadManifest(file.id);
      if (manifest?.config?.feedName) {
        localStorage.setItem(this.MANIFEST_CACHE_KEY, file.id);
        return { fileId: file.id, manifest };
      }
    }

    return null;
  }

  /** Download and parse a manifest file by ID. Returns null on any failure. */
  private async downloadManifest(fileId: string): Promise<InstallManifest | null> {
    try {
      const url = `${this.origin}/nifile/v1/service-groups/Default/files/${encodeURIComponent(fileId)}/data`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  /** Create a new manifest file in the File Service. */
  async createManifest(manifest: InstallManifest): Promise<string> {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    // The SDK's UploadData uses `metadata` as the form field for file properties JSON.
    const { data, error } = await upload({
      client: this.fileClient,
      body: {
        file: new File([blob], MANIFEST_FILE_NAME, { type: 'application/json' }),
        metadata: JSON.stringify(MANIFEST_FILE_PROPERTIES),
      },
    });
    if (error) throw new Error(`Failed to create manifest: ${JSON.stringify(error)}`);
    // UploadResponse returns { uri: string } — extract the ID from the URI
    const uri: string = (data as any)?.uri ?? '';
    const fileId = uri.split('/').pop() ?? '';
    if (fileId) localStorage.setItem(this.MANIFEST_CACHE_KEY, fileId);
    return fileId;
  }

  /** Update an existing manifest file. */
  async updateManifest(fileId: string, manifest: InstallManifest): Promise<void> {
    // Delete old, create new (File Service doesn't support in-place update)
    await deleteFile({ client: this.fileClient, path: { id: fileId } });
    await this.createManifest(manifest);
  }

  // ── Install / Upgrade / Uninstall ─────────────────────────────

  /** Install a package into a workspace. */
  async installApp(
    feedId: string,
    pkg: AppPackage,
    workspace: string,
    manifest: InstallManifest,
    manifestFileId: string | null
  ): Promise<InstallManifest> {
    // 1. Download .nipkg
    const fileName = this.extractFileName(pkg.filename);
    const nipkgBlob = await this.downloadPackageFile(feedId, fileName);

    // 2. Create webapp
    const webapp = await this.createWebapp(pkg.displayName, workspace);

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

    if (manifestFileId) {
      await this.updateManifest(manifestFileId, manifest);
    } else {
      await this.createManifest(manifest);
    }

    return manifest;
  }

  /** Upgrade an installed app to a new version. */
  async upgradeApp(
    feedId: string,
    pkg: AppPackage,
    installed: InstalledApp,
    manifest: InstallManifest,
    manifestFileId: string
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
    await this.updateManifest(manifestFileId, manifest);

    return manifest;
  }

  /** Uninstall an app from a workspace. */
  async uninstallApp(
    packageName: string,
    installed: InstalledApp,
    manifest: InstallManifest,
    manifestFileId: string
  ): Promise<InstallManifest> {
    await this.deleteWebapp(installed.webappId);
    delete manifest.installedApps[packageName];
    await this.updateManifest(manifestFileId, manifest);
    return manifest;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.origin}${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  private mapPackage(p: any): AppPackage {
    const attrs = p.attributes ?? {};
    return {
      packageName: p.packageName ?? p.package ?? '',
      version: p.version ?? '',
      displayName: p.displayName ?? attrs.DisplayName ?? p.packageName ?? '',
      description: p.description ?? '',
      section: p.section ?? '',
      maintainer: p.maintainer ?? '',
      homepage: p.homepage ?? '',
      icon: attrs.AppStoreIcon ?? '',
      screenshots: [
        attrs.AppStoreScreenshot1,
        attrs.AppStoreScreenshot2,
        attrs.AppStoreScreenshot3,
      ].filter(Boolean),
      category: attrs.AppStoreCategory ?? '',
      type: attrs.AppStoreType ?? 'webapp',
      author: attrs.AppStoreAuthor ?? '',
      license: attrs.AppStoreLicense ?? '',
      tags: attrs.AppStoreTags ?? '',
      repo: attrs.AppStoreRepo ?? '',
      minServerVersion: attrs.AppStoreMinServerVersion ?? '',
      size: p.size ?? 0,
      sha256: p.sha256 ?? '',
      filename: p.fileName ?? '',
      feedPackageId: p.id,
    };
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

  /** Create a default empty manifest. */
  createEmptyManifest(feedId: string, feedUrl: string): InstallManifest {
    return {
      version: 1,
      config: {
        feedName: FEED_NAME,
        feedId,
        githubFeedUrl: feedUrl,
      },
      installedApps: {},
    };
  }
}
