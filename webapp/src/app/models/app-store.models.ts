/** Represents an app package from the feed catalog. */
export interface AppPackage {
  /** Unique package identifier (e.g., 'mycompany-asset-dashboard'). */
  packageName: string;
  /** Semantic version string. */
  version: string;
  /** Human-readable display name. */
  displayName: string;
  /** Multi-line description. */
  description: string;
  /** Top-level section: WebApps, Notebooks, Add-Ons. */
  section: string;
  /** Maintainer name and email. */
  maintainer: string;
  /** Project homepage URL. */
  homepage: string;
  /** Base64-encoded icon (data URI). */
  icon: string;
  /** Base64-encoded screenshots (data URIs), max 3. */
  screenshots: string[];
  /** Fine-grained category (Dashboard, Data Analysis, etc.). */
  category: string;
  /** Resource type: webapp, notebook, routine, bundle. */
  type: string;
  /** Display author name. */
  author: string;
  /** SPDX license identifier. */
  license: string;
  /** Comma-separated search tags. */
  tags: string;
  /** Source code repository URL. */
  repo: string;
  /** Minimum SystemLink server version. */
  minServerVersion: string;
  /** File size in bytes. */
  size: number;
  /** SHA256 checksum. */
  sha256: string;
  /** Filename / URL to the .nipkg. */
  filename: string;
  /** Feed-level package ID (for API calls). */
  feedPackageId?: string;
  /** Feed Service feed ID this package was loaded from. */
  sourceFeedId?: string;
}

/**
 * A configured App Store feed source.
 * Stored as a JSON array in the App Store webapp's own `appstore.feeds` property.
 */
export interface FeedConfig {
  /** Human-readable feed name. */
  name: string;
  /** The packageSource URL (e.g., GitHub Pages URL or internal feed server). */
  url: string;
  /** SystemLink Feed Service feed ID for this replicated/internal feed. */
  feedId: string;
}

/** Tracks a single installed app; derived from the resource's own properties. */
export interface InstalledApp {
  /** Semantic version. */
  version: string;
  /** Resource type installed (webapp, notebook, dashboard). */
  type: AppType;
  /** Primary resource ID: webapp ID, notebook ID, or dashboard UID. */
  webappId: string;
  /** Feed Service feed ID this app was installed from. */
  feedId: string;
  /** Source URL of the feed this app was installed from. */
  feedUrl: string;
  /** ISO timestamp when first installed. */
  installedAt: string;
  /** ISO timestamp of last update, or null. */
  updatedAt: string | null;
}

/** Represents a workspace for multi-workspace support. */
export interface WorkspaceInfo {
  id: string;
  name: string;
}

/** An installed app annotated with its package name and owning workspace. */
export interface WorkspaceInstallation extends InstalledApp {
  /** App Store package name (from appstore.packageName property). */
  packageName: string;
  /** Display name of the installed resource (e.g. the webapp name). */
  resourceName: string;
  workspaceId: string;
  workspaceName: string;
  isCurrentWorkspace: boolean;
}

/** Combined view: catalog package + install status across workspaces. */
export interface AppWithStatus extends AppPackage {
  /** Workspaces where this app is installed, with their manifest data. */
  installations: Map<string, InstalledApp>;
  /** Whether an upgrade is available (catalog version > installed version). */
  upgradeAvailable: boolean;
}

/** Supported resource types for catalog items. */
export type AppType = 'webapp' | 'notebook' | 'dashboard';
export const APP_TYPES: AppType[] = ['webapp', 'notebook', 'dashboard'];
export const APP_TYPE_LABELS: Record<AppType, string> = {
  webapp: 'Web Apps',
  notebook: 'Notebooks',
  dashboard: 'Dashboards',
};

/** Default feed URL for the official App Store feed source. */
export const DEFAULT_FEED_URL = 'https://ni-kismet.github.io/systemlink-app-store/';

/** Well-known feed name used for discovery. */
export const FEED_NAME = 'SystemLink App Store';

// ── WebApp property keys ──────────────────────────────────────────────────────

/** Property key on the App Store webapp itself: JSON-serialised FeedConfig[]. */
export const APPSTORE_PROP_FEEDS = 'appstore.feeds';

/** Property keys set on every webapp installed through the App Store. */
export const APPSTORE_PROP_PACKAGE = 'appstore.packageName';
export const APPSTORE_PROP_VERSION = 'appstore.version';
export const APPSTORE_PROP_TYPE = 'appstore.type';
export const APPSTORE_PROP_FEED_ID = 'appstore.feedId';
export const APPSTORE_PROP_FEED_URL = 'appstore.feedUrl';
export const APPSTORE_PROP_INSTALLED_AT = 'appstore.installedAt';
export const APPSTORE_PROP_UPDATED_AT = 'appstore.updatedAt';

