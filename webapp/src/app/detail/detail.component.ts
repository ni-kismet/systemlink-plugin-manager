import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AppPackage, InstalledApp, InstallManifest, DEFAULT_FEED_URL } from '../models/app-store.models';
import { AppStoreService } from '../services/app-store.service';
import { formatBytes } from '../utils/semver';

@Component({
  selector: 'app-detail',
  standalone: false,
  templateUrl: './detail.component.html',
  styleUrl: './detail.component.scss',
})
export class AppDetailComponent implements OnInit {
  pkg: AppPackage | null = null;
  installed: InstalledApp | null = null;
  manifest: InstallManifest | null = null;
  manifestFileId: string | null = null;
  feedId: string | null = null;

  hasPermission = true;
  loading = true;
  actionLoading = false;
  error = '';
  confirmUninstall = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private appStoreService: AppStoreService,
  ) {}

  async ngOnInit(): Promise<void> {
    const packageName = this.route.snapshot.paramMap.get('packageName') ?? '';
    try {
      // Permission check
      try {
        await this.appStoreService.listWebapps();
      } catch {
        this.hasPermission = false;
      }

      // Load manifest
      const manifestResult = await this.appStoreService.findManifest();
      if (manifestResult) {
        this.manifest = manifestResult.manifest;
        this.manifestFileId = manifestResult.fileId;
        this.feedId = this.manifest.config.feedId;
        this.installed = this.manifest.installedApps[packageName] ?? null;
      }

      // Discover feed
      if (!this.feedId) {
        const feed = await this.appStoreService.discoverFeed();
        if (feed) this.feedId = feed.id;
      }

      if (!this.feedId) {
        this.error = 'Feed not found. Please complete onboarding first.';
        return;
      }

      // Load all packages and find by packageName
      const packages = await this.appStoreService.listPackages(this.feedId);
      this.pkg = packages.find(p => p.packageName === packageName) ?? null;

      if (!this.pkg) {
        this.error = `Package "${packageName}" not found in the catalog.`;
      }
    } catch (e: any) {
      this.error = e.message ?? 'Failed to load package details';
    } finally {
      this.loading = false;
    }
  }

  get upgradeAvailable(): boolean {
    return !!this.installed && !!this.pkg && this.installed.version !== this.pkg.version;
  }

  get formattedSize(): string {
    return this.pkg ? formatBytes(this.pkg.size) : '';
  }

  async install(): Promise<void> {
    if (!this.feedId || !this.pkg || this.actionLoading) return;
    this.actionLoading = true;
    this.error = '';
    try {
      if (!this.manifest) {
        this.manifest = this.appStoreService.createEmptyManifest(this.feedId, DEFAULT_FEED_URL);
      }
      this.manifest = await this.appStoreService.installApp(
        this.feedId,
        this.pkg,
        '',
        this.manifest,
        this.manifestFileId,
      );
      this.installed = this.manifest.installedApps[this.pkg.packageName] ?? null;
    } catch (e: any) {
      this.error = `Install failed: ${e.message}`;
    } finally {
      this.actionLoading = false;
    }
  }

  async upgrade(): Promise<void> {
    if (!this.feedId || !this.pkg || !this.installed || !this.manifest || !this.manifestFileId || this.actionLoading) return;
    this.actionLoading = true;
    this.error = '';
    try {
      this.manifest = await this.appStoreService.upgradeApp(
        this.feedId,
        this.pkg,
        this.installed,
        this.manifest,
        this.manifestFileId,
      );
      this.installed = this.manifest.installedApps[this.pkg.packageName] ?? null;
    } catch (e: any) {
      this.error = `Upgrade failed: ${e.message}`;
    } finally {
      this.actionLoading = false;
    }
  }

  async uninstall(): Promise<void> {
    if (!this.pkg || !this.installed || !this.manifest || !this.manifestFileId || this.actionLoading) return;
    this.actionLoading = true;
    this.error = '';
    this.confirmUninstall = false;
    try {
      this.manifest = await this.appStoreService.uninstallApp(
        this.pkg.packageName,
        this.installed,
        this.manifest,
        this.manifestFileId,
      );
      this.installed = null;
    } catch (e: any) {
      this.error = `Uninstall failed: ${e.message}`;
    } finally {
      this.actionLoading = false;
    }
  }

  goBack(): void {
    this.router.navigate(['/catalog']);
  }
}
