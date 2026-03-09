import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppPackage, InstalledApp, InstallManifest, DEFAULT_FEED_URL } from '../models/app-store.models';
// DEFAULT_FEED_URL is used only for createEmptyManifest (the source URL on first onboarding)
import { AppStoreService } from '../services/app-store.service';

@Component({
  selector: 'app-catalog',
  standalone: false,
  templateUrl: './catalog.component.html',
  styleUrl: './catalog.component.scss',
})
export class CatalogComponent implements OnInit {
  packages: AppPackage[] = [];
  filteredPackages: AppPackage[] = [];
  installedApps: Record<string, InstalledApp> = {};
  manifest: InstallManifest | null = null;
  feedId: string | null = null;

  searchTerm = '';
  selectedCategory = '';
  categories: string[] = [];

  hasPermission = true;
  loading = true;
  error = '';
  installingPackage: string | null = null;

  constructor(
    private appStoreService: AppStoreService,
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

      // 2. Load manifest
      const manifestResult = await this.appStoreService.findManifest();
      if (manifestResult) {
        this.manifest = manifestResult;
        this.installedApps = this.manifest.installedApps;
        this.feedId = this.manifest.config.feedId;
      }

      // 3. Discover feed
      if (!this.feedId) {
        const feed = await this.appStoreService.discoverFeed();
        if (!feed) {
          this.router.navigate(['/onboarding']);
          return;
        }
        this.feedId = feed.id;
      }

      // 4. Load packages
      this.packages = await this.appStoreService.listPackages(this.feedId);
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
    return !!installed && installed.version !== pkg.version;
  }

  openDetail(pkg: AppPackage): void {
    this.router.navigate(['/catalog', pkg.packageName]);
  }

  async install(pkg: AppPackage, event: Event): Promise<void> {
    event.stopPropagation();
    if (!this.feedId || this.installingPackage) return;

    this.installingPackage = pkg.packageName;
    try {
      if (!this.manifest) {
        this.manifest = this.appStoreService.createEmptyManifest(this.feedId, DEFAULT_FEED_URL);
      }
      this.manifest = await this.appStoreService.installApp(
        this.feedId,
        pkg,
        this.manifest,
      );
      this.installedApps = this.manifest.installedApps;
    } catch (e: any) {
      this.error = `Install failed: ${e.message}`;
    } finally {
      this.installingPackage = null;
    }
  }

  onSearchChange(value: string): void {
    this.searchTerm = value;
    this.applyFilters();
  }

  onCategoryChange(value: string): void {
    this.selectedCategory = value;
    this.applyFilters();
  }
}
