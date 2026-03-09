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
}

/** Tracks a single installed app in a workspace manifest. */
export interface InstalledApp {
  /** Semantic version. */
  version: string;
  /** Resource type installed (webapp, notebook, etc.). */
  type: string;
  /** WebApp Service webapp ID. */
  webappId: string;
  /** ISO timestamp when first installed. */
  installedAt: string;
  /** ISO timestamp of last update, or null. */
  updatedAt: string | null;
}

/** Per-workspace install manifest stored in the File Service. */
export interface InstallManifest {
  version: number;
  config: ManifestConfig;
  installedApps: Record<string, InstalledApp>;
}

export interface ManifestConfig {
  feedName: string;
  feedId: string;
  /** Remote source URL the feed was replicated from. */
  sourceUrl?: string;
}

/** Represents a workspace for multi-workspace support. */
export interface WorkspaceInfo {
  id: string;
  name: string;
}

/** Combined view: catalog package + install status across workspaces. */
export interface AppWithStatus extends AppPackage {
  /** Workspaces where this app is installed, with their manifest data. */
  installations: Map<string, InstalledApp>;
  /** Whether an upgrade is available (catalog version > installed version). */
  upgradeAvailable: boolean;
}

/** Default feed URL for the official App Store feed source. */
export const DEFAULT_FEED_URL = 'https://ni-kismet.github.io/systemlink-app-store/';

/** Well-known feed name used for discovery. */
export const FEED_NAME = 'SystemLink App Store';

/** Well-known tag path where the install manifest is stored in the Tag Service. */
export const MANIFEST_TAG_PATH = 'systemlink-app-store/manifest';
