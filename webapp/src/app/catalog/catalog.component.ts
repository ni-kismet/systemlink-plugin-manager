import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppPackage, AppType, APP_TYPES, APP_TYPE_LABELS, InstalledApp, FeedConfig } from '../models/plugin-manager.models';
import { PluginManagerService } from '../services/plugin-manager.service';
import { isNewerVersion } from '../utils/semver';

@Component({
  selector: 'app-catalog',
  standalone: false,
  templateUrl: './catalog.component.html',
  styleUrl: './catalog.component.scss',
})
export class CatalogComponent implements OnInit {
  packages: AppPackage[] = [];
  filteredPackages: AppPackage[] = [];
  /** Installed apps in the current workspace, keyed by packageName. */
  installedApps: Record<string, InstalledApp> = {};
  feedConfigs: FeedConfig[] = [];
  feedId: string | null = null;

  searchTerm = '';
  selectedCategory = '';
  selectedType: AppType | '' = '';
  appTypes = APP_TYPES;
  appTypeLabels = APP_TYPE_LABELS;
  categories: string[] = [];

  hasPermission = true;
  loading = true;
  error = '';
  installingPackage: string | null = null;

  constructor(
    private appStoreService: PluginManagerService,
    private router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      // 1. Permission check
      try {
        await this.appStoreService.listWebapps();
      } catch {
        this.hasPermission = false;
      }

      // 2. Load feed configs and installed apps for the current workspace
      const [feedConfigs, currentWorkspace, allInstallations] = await Promise.all([
        this.appStoreService.loadFeedConfigs(),
        this.appStoreService.getWorkspace(),
        this.appStoreService.listInstalledWebapps().catch(() => [] as any[]),
      ]);
      this.feedConfigs = feedConfigs;
      this.feedId = feedConfigs[0]?.feedId ?? null;

      // Build the per-workspace installed map from the current workspace only
      this.installedApps = {};
      for (const inst of allInstallations) {
        if (inst.workspaceId === currentWorkspace) {
          this.installedApps[inst.packageName] = inst;
        }
      }

      // 3. If no feed configured, fall back to feed discovery then go to onboarding
      if (feedConfigs.length === 0) {
        const feed = await this.appStoreService.discoverFeed();
        if (!feed) {
          this.router.navigate(['/onboarding']);
          return;
        }
        this.feedId = feed.id;
        this.packages = await this.appStoreService.listPackages(this.feedId);
      } else {
        // 4. Load packages from ALL configured feeds in parallel
        this.packages = await this.appStoreService.listPackagesFromFeeds(feedConfigs);
      }
      this.categories = [...new Set(this.packages.map(p => p.category).filter(Boolean))].sort();
      this.applyFilters();
    } catch (e: any) {
      this.error = e.message ?? 'Failed to load catalog';
    } finally {
      this.loading = false;
    }
  }

  applyFilters(): void {
    let result = this.packages;
    if (this.selectedType) {
      result = result.filter(p => (p.type || 'webapp').toLowerCase() === this.selectedType);
    }
    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      result = result.filter(
        p =>
          p.displayName.toLowerCase().includes(term) ||
          p.description.toLowerCase().includes(term) ||
          p.tags.toLowerCase().includes(term),
      );
    }
    if (this.selectedCategory) {
      result = result.filter(p => p.category === this.selectedCategory);
    }
    this.filteredPackages = result;
  }

  isInstalled(pkg: AppPackage): boolean {
    return pkg.packageName in this.installedApps;
  }

  hasUpgrade(pkg: AppPackage): boolean {
    const installed = this.installedApps[pkg.packageName];
    return !!installed && isNewerVersion(pkg.version, installed.version);
  }

  openDetail(pkg: AppPackage): void {
    this.router.navigate(['/catalog', pkg.packageName]);
  }

  async install(pkg: AppPackage, event: Event): Promise<void> {
    event.stopPropagation();
    if (this.installingPackage) return;

    this.installingPackage = pkg.packageName;
    const feedId = pkg.sourceFeedId ?? this.feedId;
    if (!feedId) { this.installingPackage = null; return; }
    const feedConfig = this.feedConfigs.find(f => f.feedId === feedId) ?? null;
    try {
      await this.appStoreService.installApp(feedId, pkg, feedConfig);
      // Reload installed status after install
      const currentWorkspace = await this.appStoreService.getWorkspace();
      const allInstallations = await this.appStoreService.listInstalledWebapps();
      this.installedApps = {};
      for (const inst of allInstallations) {
        if (inst.workspaceId === currentWorkspace) {
          this.installedApps[inst.packageName] = inst;
        }
      }
    } catch (e: any) {
      this.error = `Install failed: ${e.message}`;
    } finally {
      this.installingPackage = null;
    }
  }

}

