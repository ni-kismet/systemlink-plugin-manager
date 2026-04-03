/** Represents a plugin package from the catalog feed. */
export interface AppPackage {
  /** Unique package identifier (e.g., 'mycompany-asset-dashboard'). */
  packageName: string;
  /** Semantic version string. */
  version: string;
  /** Human-readable display name. */
  displayName: string;
  /** Multi-line description. */
  description: string;
  /** Fine-grained category from the control-file Section field. */
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
  /** Plugin type: webapp, notebook, dashboard, routine, bundle. */
  type: string;
  /** Display author name derived from the maintainer field. */
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
 * A configured Plugin Manager feed source.
 * Stored as a JSON array in the Plugin Manager webapp's own property bag.
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

/** An installed plugin annotated with its package name and owning workspace. */
export interface WorkspaceInstallation extends InstalledApp {
  /** Plugin package name from the Plugin Manager metadata. */
  packageName: string;
  /** Display name of the installed resource (e.g. the webapp name). */
  resourceName: string;
  workspaceId: string;
  workspaceName: string;
  isCurrentWorkspace: boolean;
}

/** Combined view: catalog package + install status across workspaces. */
export interface AppWithStatus extends AppPackage {
  /** Workspaces where this plugin is installed, with their manifest data. */
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

/** Default feed URL for the official Plugin Manager feed source. */
export const DEFAULT_FEED_URL = 'https://ni-kismet.github.io/systemlink-plugin-manager/';

/** Well-known feed name used for discovery. */
export const FEED_NAME = 'Plugin Manager for SystemLink';

/** Package name of the Plugin Manager itself in the feed. */
export const PLUGIN_MANAGER_PACKAGE_NAME = 'systemlink-plugin-manager';

/** Version of this Plugin Manager webapp build. */
export const PLUGIN_MANAGER_VERSION = '0.2.1';

// ── WebApp property keys ──────────────────────────────────────────────────────

/** Property key on the Plugin Manager webapp itself: JSON-serialised FeedConfig[]. */
export const SL_PLUGIN_MANAGER_PROP_FEEDS = 'slPluginManager.feeds';

/** Property keys set on every resource installed through the Plugin Manager. */
export const SL_PLUGIN_MANAGER_PROP_PACKAGE = 'slPluginManager.packageName';
export const SL_PLUGIN_MANAGER_PROP_VERSION = 'slPluginManager.version';
export const SL_PLUGIN_MANAGER_PROP_TYPE = 'slPluginManager.type';
export const SL_PLUGIN_MANAGER_PROP_FEED_ID = 'slPluginManager.feedId';
export const SL_PLUGIN_MANAGER_PROP_FEED_URL = 'slPluginManager.feedUrl';
export const SL_PLUGIN_MANAGER_PROP_INSTALLED_AT = 'slPluginManager.installedAt';
export const SL_PLUGIN_MANAGER_PROP_UPDATED_AT = 'slPluginManager.updatedAt';

