import { Injectable } from '@angular/core';
import {
  AppPackage,
  AppType,
  FeedConfig,
  InstalledApp,
  WorkspaceInfo,
  WorkspaceInstallation,
  FEED_NAME,
  APPSTORE_PROP_FEEDS,
  APPSTORE_PROP_PACKAGE,
  APPSTORE_PROP_VERSION,
  APPSTORE_PROP_TYPE,
  APPSTORE_PROP_FEED_ID,
  APPSTORE_PROP_FEED_URL,
  APPSTORE_PROP_INSTALLED_AT,
  APPSTORE_PROP_UPDATED_AT,
} from '../models/app-store.models';

// ── SDK imports ───────────────────────────────────────────────
import { createClient as createFeedsClient, createConfig as createFeedsConfig } from 'nisystemlink-clients-ts/feeds/client';
import {
  getNifeedV1Feeds,
  getNifeedV1FeedsByFeedIdPackages,
  postNifeedV1ReplicateFeed,
  postNifeedV1FeedsByFeedIdCheckForUpdates,
  postNifeedV1FeedsByFeedIdApplyUpdates,
  deleteNifeedV1FeedsByFeedId,
} from 'nisystemlink-clients-ts/feeds';
import type { Package } from 'nisystemlink-clients-ts/feeds';
import { createClient as createUserClient, createConfig as createUserConfig } from 'nisystemlink-clients-ts/user/client';
import { getWorkspaces } from 'nisystemlink-clients-ts/user';
import { createClient as createWebAppClient, createConfig as createWebAppConfig } from 'nisystemlink-clients-ts/web-application/client';
import {
  listWebapps as sdkListWebapps,
  createWebapp as sdkCreateWebapp,
  deleteWebapp as sdkDeleteWebapp,
  getWebapp as sdkGetWebapp,
  updateWebapp as sdkUpdateWebapp,
} from 'nisystemlink-clients-ts/web-application';
import {
  deleteNotebook as sdkDeleteNotebook,
} from 'nisystemlink-clients-ts/notebook';
import { createClient as createNotebookClient, createConfig as createNotebookConfig } from 'nisystemlink-clients-ts/notebook/client';
import { compareSemver } from '../utils/semver';
import { extractFirstMatch } from '../utils/nipkg-extract';

@Injectable({ providedIn: 'root' })
export class AppStoreService {
  private origin = window.location.origin;

  // Each generated service has a different base URL path prefix burned into its spec.
  // For browser same-origin use we replace the spec's scheme+host with window.location.origin
  // and keep the spec's path prefix so generated operation paths resolve correctly.
  // feeds: spec base = https://dev-api.../  → urls include /nifeed/v1/...
  // web-application: spec base = https://dev-api.../niapp/v1 → urls include /webapps
  private feedsClient = createFeedsClient(
    createFeedsConfig({ baseUrl: this.origin, credentials: 'include' })
  );
  private userClient = createUserClient(
    createUserConfig({ baseUrl: `${this.origin}/niuser/v1`, credentials: 'include' })
  );
  private webAppClient = createWebAppClient(
    createWebAppConfig({ baseUrl: `${this.origin}/niapp/v1`, credentials: 'include' })
  );
  private notebookClient = createNotebookClient(
    createNotebookConfig({ baseUrl: this.origin, credentials: 'include' })
  );

  private workspacePromise: Promise<string> | null = null;
  private grafanaSessionPromise: Promise<void> | null = null;

  // ── Cache ─────────────────────────────────────────────────────
  private installedCache: { promise: Promise<WorkspaceInstallation[]>; ts: number } | null = null;
  private permissionCheckCache: Promise<any> | null = null;
  private workspacesCache: Promise<WorkspaceInfo[]> | null = null;
  private static readonly CACHE_TTL_MS = 60_000; // 1 minute

  /** Invalidate installation-related caches after mutations. */
  private invalidateInstallCache(): void {
    this.installedCache = null;
  }

  // ── Feed Service ──────────────────────────────────────────────

  /** List all feeds and find the App Store feed by name. */
  async discoverFeed(): Promise<{ id: string; name: string } | null> {
    const { data, error } = await getNifeedV1Feeds({ client: this.feedsClient });
    if (error) throw new Error(`Failed to list feeds: ${JSON.stringify(error)}`);
    const feeds = data?.feeds ?? [];
    const feed = feeds.find(f => f.name === FEED_NAME);
    return feed?.id ? { id: feed.id, name: feed.name! } : null;
  }

  /** Find an existing feed whose packageSources contain the given URL. */
  async findFeedBySourceUrl(sourceUrl: string): Promise<{ id: string; name: string } | null> {
    const { data, error } = await getNifeedV1Feeds({ client: this.feedsClient });
    if (error) return null;
    const feeds = data?.feeds ?? [];
    const feed = feeds.find(f =>
      (f as any).packageSources?.some((src: string) => src === sourceUrl)
    );
    return feed?.id ? { id: feed.id, name: feed.name ?? '' } : null;
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
      .map(p => ({ ...this.mapPackageResource(p), sourceFeedId: feedId }));

    return this.selectLatestPackages(packages);
  }

  /**
   * Query all configured feeds in parallel and merge the results.
   * For packages that appear in multiple feeds, the highest semver wins.
   * Each returned AppPackage retains the sourceFeedId of the feed it came from,
   * so downstream install/download calls use the correct feed.
   */
  async listPackagesFromFeeds(feeds: FeedConfig[]): Promise<AppPackage[]> {
    if (feeds.length === 0) return [];

    const results = await Promise.allSettled(
      feeds.map(feed => this.listPackages(feed.feedId))
    );

    const all: AppPackage[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        all.push(...result.value);
      }
      // Silently ignore failed feeds so one bad feed doesn't break the catalog
    }

    return this.selectLatestPackages(all);
  }

  /** Download a package file (returns a Blob). */
  async downloadPackageFile(feedId: string, fileName: string): Promise<Blob> {
    const url = `${this.origin}/nifeed/v1/feeds/${encodeURIComponent(feedId)}/files/${encodeURIComponent(fileName)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    return res.blob();
  }

  /** Replicate a feed from a remote URL. */
  async replicateFeed(feedUrl: string, name: string = FEED_NAME): Promise<any> {
    const { data, error } = await postNifeedV1ReplicateFeed({
      client: this.feedsClient,
      body: {
        name,
        platform: 'WINDOWS',
        urls: [feedUrl],
      },
    });
    if (error) throw new Error(`Failed to replicate feed: ${JSON.stringify(error)}`);
    return data;
  }

  /** Delete a replicated feed by ID. */
  async deleteReplicatedFeed(feedId: string): Promise<void> {
    const { error } = await deleteNifeedV1FeedsByFeedId({
      client: this.feedsClient,
      path: { feedId },
    });
    if (error) throw new Error(`Failed to delete feed: ${JSON.stringify(error)}`);
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

  /** Extract the App Store webapp's own ID from the current URL (sync, no fetch). */
  getOwnWebappId(): string | null {
    const match = window.location.href.match(/\/webapps\/([0-9a-f-]{36})\//);
    return match ? match[1] : null;
  }

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

  /** Create a new webapp. Returns the created webapp (with id).
   * Properties are set via a separate update call because the WebApp
   * Service rejects custom property keys on the create endpoint. */
  async createWebapp(name: string, workspace: string, properties?: Record<string, string>): Promise<any> {
    const { data, error } = await sdkCreateWebapp({
      client: this.webAppClient,
      body: { name, workspace, policyIds: [] },
    });
    if (error) throw new Error(`Failed to create webapp: ${JSON.stringify(error)}`);

    if (properties && data?.id) {
      const { error: updateError } = await sdkUpdateWebapp({
        client: this.webAppClient,
        path: { id: data.id },
        body: { name, policyIds: [], properties },
      });
      if (updateError) throw new Error(`Failed to set webapp properties: ${JSON.stringify(updateError)}`);
    }

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

  /** List webapps (to check permissions). Cached for the service lifetime. */
  async listWebapps(): Promise<any> {
    if (!this.permissionCheckCache) {
      this.permissionCheckCache = sdkListWebapps({
        client: this.webAppClient,
        query: { take: 1 } as any,
      }).then(({ data, error }) => {
        if (error) {
          this.permissionCheckCache = null;
          throw new Error(`Failed to list webapps: ${JSON.stringify(error)}`);
        }
        return data;
      });
    }
    return this.permissionCheckCache;
  }

  /** List all webapps the user can see, handling pagination. */
  private async listAllWebapps(): Promise<any[]> {
    const all: any[] = [];
    let continuationToken: string | undefined;

    do {
      const { data, error } = await sdkListWebapps({
        client: this.webAppClient,
        query: { take: 200, ...(continuationToken ? { continuationToken } : {}) } as any,
      });
      if (error) break;
      const webapps = (data as any)?.webapps ?? [];
      all.push(...webapps);
      continuationToken = (data as any)?.continuationToken ?? undefined;
    } while (continuationToken);

    return all;
  }

  /** List workspaces the current user can read. Cached for the service lifetime. */
  async listReadableWorkspaces(): Promise<WorkspaceInfo[]> {
    if (!this.workspacesCache) {
      this.workspacesCache = (async () => {
        const { data, error } = await getWorkspaces({ client: this.userClient });
        if (error) {
          this.workspacesCache = null;
          throw new Error(`Failed to list workspaces: ${JSON.stringify(error)}`);
        }
        return (data?.workspaces ?? [])
          .filter((workspace): workspace is { id: string; name?: string } => !!workspace?.id)
          .map(workspace => ({
            id: workspace.id,
            name: workspace.name?.trim() || workspace.id,
          }))
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      })();
    }
    return this.workspacesCache;
  }

  // ── Feed config (stored in App Store webapp properties) ───────

  /**
   * Load the list of registered App Store feeds from the App Store webapp's
   * own `appstore.feeds` property. Returns an empty array if none are configured.
   */
  async loadFeedConfigs(): Promise<FeedConfig[]> {
    const ownId = this.getOwnWebappId();
    if (!ownId) return [];

    const { data, error } = await sdkGetWebapp({
      client: this.webAppClient,
      path: { id: ownId },
    });
    if (error) return [];

    const feedsJson = ((data as any)?.properties ?? {})[APPSTORE_PROP_FEEDS];
    if (!feedsJson || typeof feedsJson !== 'string') return [];

    try {
      return JSON.parse(feedsJson) as FeedConfig[];
    } catch {
      return [];
    }
  }

  /**
   * Persist the list of registered feeds to the App Store webapp's properties.
   * Merges with any existing non-appstore properties so they are preserved.
   */
  async saveFeedConfigs(feeds: FeedConfig[]): Promise<void> {
    const ownId = this.getOwnWebappId();
    if (!ownId) throw new Error('Cannot save feed config: App Store webapp ID not found');

    // Read current webapp so we can preserve name, policyIds, and non-appstore properties.
    const { data: current } = await sdkGetWebapp({
      client: this.webAppClient,
      path: { id: ownId },
    });
    const existing = ((current as any)?.properties ?? {}) as Record<string, string>;
    const name = (current as any)?.name ?? '';
    const policyIds = (current as any)?.policyIds ?? [];

    const { error } = await sdkUpdateWebapp({
      client: this.webAppClient,
      path: { id: ownId },
      body: {
        name,
        policyIds,
        properties: this.stripEmptyValues({
          ...existing,
          [APPSTORE_PROP_FEEDS]: JSON.stringify(feeds),
        }),
      },
    });
    if (error) throw new Error(`Failed to save feed configs: ${JSON.stringify(error)}`);
  }

  // ── Installed resource discovery ────────────────────────────────

  /**
   * Return all resources installed through the App Store across all
   * workspaces visible to the current user.
   * Queries webapps, notebooks, and dashboards in parallel.
   */
  async listInstalledWebapps(): Promise<WorkspaceInstallation[]> {
    const now = Date.now();
    if (this.installedCache && (now - this.installedCache.ts) < AppStoreService.CACHE_TTL_MS) {
      return this.installedCache.promise;
    }
    const promise = this.fetchInstalledWebapps();
    this.installedCache = { promise, ts: now };
    // If the fetch fails, clear the cache so next call retries
    promise.catch(() => { this.installedCache = null; });
    return promise;
  }

  private async fetchInstalledWebapps(): Promise<WorkspaceInstallation[]> {
    const [currentWorkspace, workspaces, webapps, notebooks, dashboards, feedConfigs] = await Promise.all([
      this.getWorkspace(),
      this.listReadableWorkspaces().catch(() => [] as WorkspaceInfo[]),
      this.listAllWebapps(),
      this.listAppStoreNotebooks().catch(() => []),
      this.listAppStoreDashboards().catch(() => []),
      this.loadFeedConfigs().catch(() => [] as FeedConfig[]),
    ]);

    const workspaceNames = new Map(workspaces.map(w => [w.id, w.name]));
    const installations: WorkspaceInstallation[] = [];

    // Webapps: identified by appstore.packageName property
    for (const webapp of webapps) {
      const props = ((webapp.properties ?? {}) as Record<string, string>);
      const packageName = props[APPSTORE_PROP_PACKAGE];
      if (!packageName) continue;

      const workspaceId = webapp.workspace ?? '';
      installations.push({
        packageName,
        resourceName: webapp.name ?? '',
        version: props[APPSTORE_PROP_VERSION] ?? '',
        type: (props[APPSTORE_PROP_TYPE] ?? 'webapp') as AppType,
        webappId: webapp.id ?? '',
        feedId: props[APPSTORE_PROP_FEED_ID] ?? '',
        feedUrl: props[APPSTORE_PROP_FEED_URL] ?? '',
        installedAt: props[APPSTORE_PROP_INSTALLED_AT] ?? '',
        updatedAt: props[APPSTORE_PROP_UPDATED_AT] || null,
        workspaceId,
        workspaceName: workspaceNames.get(workspaceId) ?? workspaceId,
        isCurrentWorkspace: workspaceId === currentWorkspace,
      });
    }

    // Notebooks: identified by appstore.packageName in notebook properties
    for (const nb of notebooks) {
      const props = (nb.properties ?? {}) as Record<string, string>;
      const packageName = props[APPSTORE_PROP_PACKAGE];
      if (!packageName) continue;

      const workspaceId = nb.workspace ?? '';
      installations.push({
        packageName,
        resourceName: nb.name ?? '',
        version: props[APPSTORE_PROP_VERSION] ?? '',
        type: 'notebook',
        webappId: nb.id ?? '',
        feedId: props[APPSTORE_PROP_FEED_ID] ?? '',
        feedUrl: props[APPSTORE_PROP_FEED_URL] ?? '',
        installedAt: props[APPSTORE_PROP_INSTALLED_AT] ?? '',
        updatedAt: props[APPSTORE_PROP_UPDATED_AT] || null,
        workspaceId,
        workspaceName: workspaceNames.get(workspaceId) ?? workspaceId,
        isCurrentWorkspace: workspaceId === currentWorkspace,
      });
    }

    // Build a map from Grafana folder title -> workspace for dashboard workspace association
    // SystemLink folders are named "{WorkspaceName} Workspace"
    const folderToWorkspace = new Map<string, { id: string; name: string }>();
    for (const w of workspaces) {
      folderToWorkspace.set(`${w.name} Workspace`, { id: w.id, name: w.name });
    }

    // Dashboards: identified by 'appstore' tag, metadata encoded in tag prefixes
    for (const db of dashboards) {
      const tags: string[] = db.tags ?? [];
      if (!tags.includes('appstore')) continue;

      // Extract metadata from hyphen-prefixed tags
      const pkgTag = tags.find((t: string) => t.startsWith('appstore-pkg-'));
      const verTag = tags.find((t: string) => t.startsWith('appstore-ver-'));
      const feedTag = tags.find((t: string) => t.startsWith('appstore-feed-'));
      const packageName = pkgTag?.substring('appstore-pkg-'.length) ?? '';
      if (!packageName) continue;

      // Look up feedUrl from feed config using feedId
      const feedId = feedTag?.substring('appstore-feed-'.length) ?? '';
      const feedUrl = feedId ? (feedConfigs.find(f => f.feedId === feedId)?.url ?? '') : '';

      // Infer workspace from Grafana folder title
      const folderTitle: string = db.folderTitle ?? '';
      const mappedWorkspace = folderToWorkspace.get(folderTitle);

      installations.push({
        packageName,
        resourceName: db.title ?? '',
        version: verTag?.substring('appstore-ver-'.length) ?? '',
        type: 'dashboard',
        webappId: String(db.uid ?? db.id ?? ''),
        feedId,
        feedUrl,
        installedAt: '',
        updatedAt: null,
        workspaceId: mappedWorkspace?.id ?? '',
        workspaceName: mappedWorkspace?.name ?? (folderTitle || 'Dashboards'),
        isCurrentWorkspace: mappedWorkspace?.id === currentWorkspace,
      });
    }

    return installations;
  }

  /** Query notebooks that have appstore metadata in their properties. */
  private async listAppStoreNotebooks(): Promise<any[]> {
    const res = await fetch(`${this.origin}/ninotebook/v1/notebook/query`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: `!string.IsNullOrEmpty(properties.${APPSTORE_PROP_PACKAGE})`,
        take: 1000,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.notebooks ?? [];
  }

  /** Search for Grafana dashboards tagged with 'appstore'. */
  private async listAppStoreDashboards(): Promise<any[]> {
    await this.ensureGrafanaSession();
    const res = await fetch(
      `${this.origin}/dashboardhost/api/search?type=dash-db&tag=appstore&limit=1000`,
      { credentials: 'include' },
    );
    if (!res.ok) return [];
    return res.json();
  }

  // ── Install / Upgrade / Uninstall ─────────────────────────────

  /** Install a package into a workspace.
   * Routes to the appropriate service based on package type. */
  async installApp(
    feedId: string,
    pkg: AppPackage,
    feedConfig: FeedConfig | null,
    workspace?: string,
  ): Promise<void> {
    const resolvedWorkspace = workspace ? workspace : await this.getWorkspace();
    if (!resolvedWorkspace) throw new Error('Cannot install app: workspace unknown');

    const pkgType = (pkg.type || 'webapp').toLowerCase() as AppType;

    if (pkgType === 'notebook') {
      await this.installNotebook(feedId, pkg, feedConfig, resolvedWorkspace);
    } else if (pkgType === 'dashboard') {
      await this.installDashboard(feedId, pkg, feedConfig, resolvedWorkspace);
    } else {
      const nipkgBlob = await this.downloadPackageFile(feedId, this.extractFileName(pkg.filename));
      const properties = this.buildAppStoreProperties(pkg, feedConfig);
      const webapp = await this.createWebapp(pkg.displayName, resolvedWorkspace, properties);
      await this.uploadContent(webapp.id, nipkgBlob);
    }
    this.invalidateInstallCache();
  }

  /** Install a notebook into the notebook service with appstore metadata in its properties. */
  private async installNotebook(
    feedId: string,
    pkg: AppPackage,
    feedConfig: FeedConfig | null,
    workspace: string,
  ): Promise<void> {
    const nipkgBlob = await this.downloadPackageFile(feedId, this.extractFileName(pkg.filename));

    // Extract the .ipynb notebook file from the nipkg archive.
    const notebookContent = await extractFirstMatch(
      nipkgBlob,
      path => path.endsWith('.ipynb'),
    );

    // Build metadata with all appstore properties so the notebook is self-describing.
    const properties = this.buildAppStoreProperties(pkg, feedConfig);
    const metadata = { name: pkg.displayName, workspace, properties };

    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    );
    formData.append(
      'content',
      new Blob([notebookContent], { type: 'application/octet-stream' }),
      `${pkg.packageName}.ipynb`,
    );

    const res = await fetch(`${this.origin}/ninotebook/v1/notebook`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Failed to create notebook (${res.status}): ${detail}`);
    }
  }

  /** Install a dashboard into the dashboardhost (Grafana) service.
   * Grafana has no key-value properties — we use tags for appstore metadata. */
  private async installDashboard(
    feedId: string,
    pkg: AppPackage,
    feedConfig: FeedConfig | null,
    workspace: string,
  ): Promise<void> {
    await this.ensureGrafanaSession();
    const nipkgBlob = await this.downloadPackageFile(feedId, this.extractFileName(pkg.filename));

    // Extract dashboard JSON model from nipkg archive
    let dashboardModel: any;
    try {
      const jsonBlob = await extractFirstMatch(nipkgBlob, p => p.endsWith('.json'));
      dashboardModel = JSON.parse(await jsonBlob.text());
    } catch {
      // Fallback: try reading the blob directly as JSON (non-nipkg package)
      try {
        dashboardModel = JSON.parse(await nipkgBlob.text());
      } catch {
        dashboardModel = {};
      }
    }

    // Find the Grafana folder that corresponds to the target workspace
    const folderUid = await this.getGrafanaFolderUid(workspace);

    // Encode appstore metadata in dashboard tags for discovery.
    // Use simple hyphen-separated tags — Grafana lowercases tags and
    // complex values (URLs, colons) can cause import failures.
    const tags = [
      'appstore',
      `appstore-pkg-${pkg.packageName}`,
      `appstore-ver-${pkg.version}`,
      ...(feedConfig?.feedId ? [`appstore-feed-${feedConfig.feedId}`] : []),
    ];

    // Use the /api/dashboards/import endpoint which normalizes the model,
    // fills in missing default fields, and handles datasource mappings —
    // unlike /api/dashboards/db which expects a fully-formed internal model.
    const body: Record<string, any> = {
      dashboard: {
        ...dashboardModel,
        title: pkg.displayName,
        tags,
        id: null,
      },
      overwrite: true,
      inputs: [],
    };
    if (folderUid) {
      body['folderUid'] = folderUid;
    }

    const res = await fetch(`${this.origin}/dashboardhost/api/dashboards/import`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to import dashboard: ${res.status} ${res.statusText}`);
  }

  /** Install a package into one or more workspaces. */
  async installAppAcrossWorkspaces(
    feedId: string,
    pkg: AppPackage,
    workspaces: string[],
    feedConfig: FeedConfig | null,
  ): Promise<void> {
    if (workspaces.length === 0) return;
    for (const workspace of workspaces) {
      await this.installApp(feedId, pkg, feedConfig, workspace);
    }
  }

  /** Upgrade an installed app to a new version.
   * Routes to the appropriate service based on resource type. */
  async upgradeApp(
    feedId: string,
    pkg: AppPackage,
    installed: InstalledApp,
  ): Promise<void> {
    const fileName = this.extractFileName(pkg.filename);
    const nipkgBlob = await this.downloadPackageFile(feedId, fileName);

    if (installed.type === 'notebook') {
      await this.upgradeNotebook(installed.webappId, pkg, nipkgBlob);
    } else if (installed.type === 'dashboard') {
      await this.upgradeDashboard(installed.webappId, pkg, nipkgBlob);
    } else {
      await this.uploadContent(installed.webappId, nipkgBlob);
      await this.updateInstalledVersion(installed.webappId, pkg.version);
    }
    this.invalidateInstallCache();
  }

  /** Upgrade every installation of a package to the catalog version. */
  async upgradeAppAcrossWorkspaces(
    feedId: string,
    pkg: AppPackage,
    installations: WorkspaceInstallation[],
  ): Promise<void> {
    const fileName = this.extractFileName(pkg.filename);
    const nipkgBlob = await this.downloadPackageFile(feedId, fileName);

    for (const installation of installations) {
      if (installation.type === 'notebook') {
        await this.upgradeNotebook(installation.webappId, pkg, nipkgBlob);
      } else if (installation.type === 'dashboard') {
        await this.upgradeDashboard(installation.webappId, pkg, nipkgBlob);
      } else {
        await this.uploadContent(installation.webappId, nipkgBlob);
        await this.updateInstalledVersion(installation.webappId, pkg.version);
      }
    }
    this.invalidateInstallCache();
  }

  /** Upgrade a notebook: replace content and update version in properties. */
  private async upgradeNotebook(notebookId: string, pkg: AppPackage, nipkgBlob: Blob): Promise<void> {
    const notebookContent = await extractFirstMatch(nipkgBlob, p => p.endsWith('.ipynb'));

    const metadata = {
      properties: {
        [APPSTORE_PROP_VERSION]: pkg.version,
        [APPSTORE_PROP_UPDATED_AT]: new Date().toISOString(),
      },
    };
    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    );
    formData.append(
      'content',
      new Blob([notebookContent], { type: 'application/octet-stream' }),
      `${pkg.packageName}.ipynb`,
    );

    const res = await fetch(`${this.origin}/ninotebook/v1/notebook/${encodeURIComponent(notebookId)}`, {
      method: 'PUT',
      credentials: 'include',
      body: formData,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Failed to upgrade notebook (${res.status}): ${detail}`);
    }
  }

  /** Upgrade a dashboard: update the dashboard model and version tag. */
  private async upgradeDashboard(dashboardUid: string, pkg: AppPackage, nipkgBlob: Blob): Promise<void> {
    await this.ensureGrafanaSession();
    // Fetch current dashboard to get existing model
    const getRes = await fetch(
      `${this.origin}/dashboardhost/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`,
      { credentials: 'include' },
    );
    if (!getRes.ok) throw new Error(`Failed to fetch dashboard for upgrade: ${getRes.status}`);
    const current = await getRes.json();

    let newModel: any;
    try {
      const jsonBlob = await extractFirstMatch(nipkgBlob, p => p.endsWith('.json'));
      newModel = JSON.parse(await jsonBlob.text());
    } catch {
      newModel = current.dashboard ?? {};
    }

    // Update the version tag
    const existingTags: string[] = (current.dashboard?.tags ?? []).filter(
      (t: string) => !t.startsWith('appstore-ver-'),
    );
    existingTags.push(`appstore-ver-${pkg.version}`);

    const body = {
      dashboard: {
        ...newModel,
        id: current.dashboard?.id,
        uid: dashboardUid,
        title: pkg.displayName,
        tags: existingTags,
        version: current.dashboard?.version ?? 0,
      },
      message: `Upgraded from App Store: ${pkg.packageName} v${pkg.version}`,
      overwrite: true,
      folderUid: current.meta?.folderUid,
    };

    const res = await fetch(`${this.origin}/dashboardhost/api/dashboards/db/`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to upgrade dashboard: ${res.status}`);
  }

  /** Uninstall an app from a single workspace.
   * Routes to the correct service based on resource type. */
  async uninstallApp(installed: InstalledApp): Promise<void> {
    await this.deleteResource(installed);
    this.invalidateInstallCache();
  }

  /** Uninstall a package from every workspace where it is currently installed. */
  async uninstallAppAcrossWorkspaces(installations: WorkspaceInstallation[]): Promise<void> {
    for (const installation of installations) {
      await this.deleteResource(installation);
    }
    this.invalidateInstallCache();
  }

  /** Delete the actual resource based on its type. */
  private async deleteResource(installed: InstalledApp): Promise<void> {
    if (installed.type === 'notebook') {
      await sdkDeleteNotebook({
        client: this.notebookClient,
        path: { id: installed.webappId },
      });
    } else if (installed.type === 'dashboard') {
      await this.ensureGrafanaSession();
      const res = await fetch(
        `${this.origin}/dashboardhost/api/dashboards/uid/${encodeURIComponent(installed.webappId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`Failed to delete dashboard: ${res.status}`);
      }
    } else {
      await this.deleteWebapp(installed.webappId);
    }
  }

  // ── Grafana auth ───────────────────────────────────────────────

  /**
   * Ensure the browser has a valid Grafana session cookie.
   *
   * Grafana sits behind an auth-proxy that only handles authentication on the
   * `/dashboardhost/login` path. Hitting that endpoint with the SystemLink
   * `session-id` cookie causes the proxy to validate the session, set the
   * `X-WEBAUTH-USER` header, and Grafana issues its own session cookie
   * (`grafana_session`). All subsequent API requests use that cookie.
   *
   * We fetch `/dashboardhost/login` once per service lifetime; the result is
   * cached so concurrent callers share the same promise.
   */
  /**
   * Find the Grafana folder UID that corresponds to a SystemLink workspace.
   * SystemLink creates folders named "{WorkspaceName} Workspace" for each workspace.
   */
  private async getGrafanaFolderUid(workspaceId: string): Promise<string | null> {
    try {
      // Resolve workspace name from ID
      const workspaces = await this.listReadableWorkspaces();
      const workspace = workspaces.find(w => w.id === workspaceId);
      if (!workspace) return null;

      const expectedTitle = `${workspace.name} Workspace`;

      // List Grafana folders and find the matching one
      const res = await fetch(`${this.origin}/dashboardhost/api/folders?limit=200`, {
        credentials: 'include',
      });
      if (!res.ok) return null;
      const folders: any[] = await res.json();
      const match = folders.find((f: any) => f.title === expectedTitle);
      return match?.uid ?? null;
    } catch {
      return null;
    }
  }

  private ensureGrafanaSession(): Promise<void> {
    if (!this.grafanaSessionPromise) {
      this.grafanaSessionPromise = fetch(`${this.origin}/dashboardhost/login`, {
        credentials: 'include',
        redirect: 'follow',
      }).then(res => {
        if (!res.ok) {
          // Reset so a retry is possible
          this.grafanaSessionPromise = null;
          throw new Error(`Grafana login failed: ${res.status}`);
        }
      }).catch(err => {
        this.grafanaSessionPromise = null;
        throw err;
      });
    }
    return this.grafanaSessionPromise;
  }

  // ── Helpers ───────────────────────────────────────────────────

  /** Build the `appstore.*` property map for an installed resource. */
  private buildAppStoreProperties(pkg: AppPackage, feedConfig: FeedConfig | null): Record<string, string> {
    return this.stripEmptyValues({
      [APPSTORE_PROP_PACKAGE]: pkg.packageName,
      [APPSTORE_PROP_VERSION]: pkg.version,
      [APPSTORE_PROP_TYPE]: pkg.type,
      [APPSTORE_PROP_FEED_ID]: feedConfig?.feedId ?? '',
      [APPSTORE_PROP_FEED_URL]: feedConfig?.url ?? '',
      [APPSTORE_PROP_INSTALLED_AT]: new Date().toISOString(),
    });
  }

  /** Merge updated version/timestamp into an installed webapp's properties. */
  private async updateInstalledVersion(webappId: string, newVersion: string): Promise<void> {
    const { data: current } = await sdkGetWebapp({
      client: this.webAppClient,
      path: { id: webappId },
    });
    const existing = ((current as any)?.properties ?? {}) as Record<string, string>;
    const name = (current as any)?.name ?? '';
    const policyIds = (current as any)?.policyIds ?? [];

    const { error } = await sdkUpdateWebapp({
      client: this.webAppClient,
      path: { id: webappId },
      body: {
        name,
        policyIds,
        properties: this.stripEmptyValues({
          ...existing,
          [APPSTORE_PROP_VERSION]: newVersion,
          [APPSTORE_PROP_UPDATED_AT]: new Date().toISOString(),
        }),
      },
    });
    if (error) throw new Error(`Failed to update webapp properties after upgrade: ${JSON.stringify(error)}`);
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
   * First-class fields come from metadata.*, custom App Store fields from metadata.attributes.
   * The Feed Service is expected to strip the XB- prefix from attribute names, but this has
   * not been confirmed to be consistent across all versions. We therefore check bare names
   * first and fall back to XB-prefixed variants as a defensive measure. */
  private mapPackageResource(pkg: Package): AppPackage {
    const m = pkg.metadata ?? {};
    const attrs = m.attributes ?? {};
    // Helper: look up a key trying the bare name first, then the XB- prefixed variant.
    const attr = (key: string): string => attrs[key] ?? attrs[`XB-${key}`] ?? '';
    return {
      packageName: m.packageName ?? '',
      version: m.version ?? attr('DisplayVersion'),
      displayName: attr('DisplayName') || (m.packageName ?? ''),
      description: m.description ?? '',
      section: m.section ?? '',
      maintainer: m.maintainer ?? '',
      homepage: m.homepage ?? '',
      icon: attr('AppStoreIcon'),
      screenshots: [
        attr('AppStoreScreenshot1'),
        attr('AppStoreScreenshot2'),
        attr('AppStoreScreenshot3'),
      ].filter((v): v is string => !!v),
      category: attr('AppStoreCategory'),
      type: attr('AppStoreType') || 'webapp',
      author: attr('AppStoreAuthor'),
      license: attr('AppStoreLicense'),
      tags: m.tags ?? attr('AppStoreTags'),
      repo: attr('AppStoreRepo') || (m.homepage ?? ''),
      minServerVersion: attr('AppStoreMinServerVersion'),
      size: m.size ?? 0,
      sha256: attr('SHA256'),
      filename: m.fileName ?? '',
      feedPackageId: pkg.id ?? undefined,
    };
  }

  private isUserVisibleWebappResource(pkg: Package): boolean {
    const attrs = pkg.metadata?.attributes ?? {};
    const attr = (key: string): string => attrs[key] ?? attrs[`XB-${key}`] ?? '';
    if (attr('UserVisible') === 'no') return false;
    const packageType = attr('AppStoreType').trim().toLowerCase();
    if (packageType) return ['webapp', 'notebook', 'dashboard'].includes(packageType);
    const section = (pkg.metadata?.section ?? '').trim();
    return ['WebApps', 'Notebooks'].includes(section);
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

  /** Remove entries with empty-string values — the WebApp Service rejects them. */
  private stripEmptyValues(props: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== ''));
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
}
