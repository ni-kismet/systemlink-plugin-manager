import { Injectable } from '@angular/core';
import {
  AppPackage,
  InstallManifest,
  InstalledApp,
  FEED_NAME,
  MANIFEST_TAG_PATH,
} from '../models/app-store.models';

// ── SDK imports ───────────────────────────────────────────────
import { createClient as createFeedsClient, createConfig as createFeedsConfig } from 'nisystemlink-clients-ts/feeds/client';
import {
  getNifeedV1Feeds,
  postNifeedV1ReplicateFeed,
  postNifeedV1FeedsByFeedIdCheckForUpdates,
  postNifeedV1FeedsByFeedIdApplyUpdates,
} from 'nisystemlink-clients-ts/feeds';
import { createClient as createTagClient, createConfig as createTagConfig } from 'nisystemlink-clients-ts/tags/client';
import { createOrReplaceTagInWorkspace, updateTagCurrentValuesInWorkspace, getTagWithValueInWorkspace } from 'nisystemlink-clients-ts/tags';
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
  private tagClient = createTagClient(
    createTagConfig({ baseUrl: `${this.origin}/nitag`, credentials: 'include' })
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

  /** List all packages in a feed by fetching and parsing the replicated Packages index. */
  async listPackages(feedId: string): Promise<AppPackage[]> {
    const url = `${this.origin}/nifeed/v1/feeds/${encodeURIComponent(feedId)}/files/Packages`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to fetch Packages index: HTTP ${res.status}`);
    const text = await res.text();
    return this.parsePackagesIndex(text)
      .filter(s => s['UserVisible'] !== 'no')
      .map(s => this.mapStanza(s));
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
    try {
      const manifest = JSON.parse(data.current.value.value) as InstallManifest;
      if (!manifest?.config?.feedName) return null;
      return manifest;
    } catch {
      return null;
    }
  }

  /**
   * Persist the manifest to the Tag Service (create or update).
   * Uses createOrReplaceTagInWorkspace to upsert the tag metadata,
   * then writes the JSON-serialised manifest as the current value.
   */
  async saveManifest(manifest: InstallManifest): Promise<void> {
    const workspace = await this.getWorkspace();
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
  ): Promise<InstallManifest> {
    // 1. Resolve workspace and download .nipkg in parallel
    const [workspace, nipkgBlob] = await Promise.all([
      this.getWorkspace(),
      this.downloadPackageFile(feedId, this.extractFileName(pkg.filename)),
    ]);

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
    await this.saveManifest(manifest);

    return manifest;
  }

  /** Upgrade an installed app to a new version. */
  async upgradeApp(
    feedId: string,
    pkg: AppPackage,
    installed: InstalledApp,
    manifest: InstallManifest,
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
    await this.saveManifest(manifest);

    return manifest;
  }

  /** Uninstall an app from a workspace. */
  async uninstallApp(
    packageName: string,
    installed: InstalledApp,
    manifest: InstallManifest,
  ): Promise<InstallManifest> {
    await this.deleteWebapp(installed.webappId);
    delete manifest.installedApps[packageName];
    await this.saveManifest(manifest);
    return manifest;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.origin}${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /** Parse an RFC 822-style Packages index into an array of field maps. */
  private parsePackagesIndex(text: string): Record<string, string>[] {
    return text.split(/\n\n+/).filter(s => s.trim()).map(stanza => {
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

  /** Map a parsed Packages index stanza to an AppPackage. */
  private mapStanza(s: Record<string, string>): AppPackage {
    return {
      packageName: s['Package'] ?? '',
      version: s['Version'] ?? s['DisplayVersion'] ?? '',
      displayName: s['DisplayName'] ?? s['Package'] ?? '',
      description: s['Description'] ?? '',
      section: s['Section'] ?? '',
      maintainer: s['Maintainer'] ?? '',
      homepage: s['Homepage'] ?? '',
      icon: s['AppStoreIcon'] ?? '',
      screenshots: [
        s['AppStoreScreenshot1'],
        s['AppStoreScreenshot2'],
        s['AppStoreScreenshot3'],
      ].filter((v): v is string => !!v),
      category: s['AppStoreCategory'] ?? '',
      type: s['AppStoreType'] ?? 'webapp',
      author: s['AppStoreAuthor'] ?? '',
      license: s['AppStoreLicense'] ?? '',
      tags: s['AppStoreTags'] ?? '',
      repo: s['AppStoreRepo'] ?? '',
      minServerVersion: s['AppStoreMinServerVersion'] ?? '',
      size: s['Size'] ? parseInt(s['Size'], 10) : 0,
      sha256: s['SHA256'] ?? '',
      filename: s['Filename'] ?? '',
      feedPackageId: undefined,
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
