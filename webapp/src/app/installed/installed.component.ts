import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppPackage, InstalledApp, InstallManifest, DEFAULT_FEED_URL } from '../models/app-store.models';
import { AppStoreService } from '../services/app-store.service';
import { isNewerVersion } from '../utils/semver';

interface InstalledEntry {
  packageName: string;
  installed: InstalledApp;
  catalogPkg: AppPackage | null;
  upgradeAvailable: boolean;
}

@Component({
  selector: 'app-installed',
  standalone: false,
  templateUrl: './installed.component.html',
  styleUrl: './installed.component.scss',
})
export class InstalledComponent implements OnInit {
  entries: InstalledEntry[] = [];
  manifest: InstallManifest | null = null;
  manifestFileId: string | null = null;
  feedId: string | null = null;

  hasPermission = true;
  loading = true;
  error = '';
  actionLoading: string | null = null;
  upgradingAll = false;

  constructor(
    private appStoreService: AppStoreService,
    public router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      try {
        await this.appStoreService.listWebapps();
      } catch {
        this.hasPermission = false;
      }

      const manifestResult = await this.appStoreService.findManifest();
      if (!manifestResult) {
        this.loading = false;
        return;
      }

      this.manifest = manifestResult.manifest;
      this.manifestFileId = manifestResult.fileId;
      this.feedId = this.manifest.config.feedId;

      // Load catalog to compare versions
      let catalogMap = new Map<string, AppPackage>();
      if (this.feedId) {
        const packages = await this.appStoreService.listPackages(this.feedId);
        for (const p of packages) {
          catalogMap.set(p.packageName, p);
        }
      }

      // Build entries
      this.entries = Object.entries(this.manifest.installedApps).map(([name, app]) => {
        const catalogPkg = catalogMap.get(name) ?? null;
        return {
          packageName: name,
          installed: app,
          catalogPkg,
          upgradeAvailable: !!catalogPkg && isNewerVersion(catalogPkg.version, app.version),
        };
      });
    } catch (e: any) {
      this.error = e.message ?? 'Failed to load installed apps';
    } finally {
      this.loading = false;
    }
  }

  get upgradesAvailable(): number {
    return this.entries.filter(e => e.upgradeAvailable).length;
  }

  openDetail(entry: InstalledEntry): void {
    this.router.navigate(['/catalog', entry.packageName]);
  }

  async upgrade(entry: InstalledEntry): Promise<void> {
    if (!this.feedId || !entry.catalogPkg || !this.manifest || !this.manifestFileId || this.actionLoading) return;
    this.actionLoading = entry.packageName;
    try {
      this.manifest = await this.appStoreService.upgradeApp(
        this.feedId,
        entry.catalogPkg,
        entry.installed,
        this.manifest,
        this.manifestFileId,
      );
      entry.installed = this.manifest.installedApps[entry.packageName];
      entry.upgradeAvailable = false;
    } catch (e: any) {
      this.error = `Upgrade of ${entry.packageName} failed: ${e.message}`;
    } finally {
      this.actionLoading = null;
    }
  }

  async upgradeAll(): Promise<void> {
    if (!this.feedId || !this.manifest || !this.manifestFileId) return;
    this.upgradingAll = true;
    for (const entry of this.entries) {
      if (entry.upgradeAvailable && entry.catalogPkg) {
        await this.upgrade(entry);
      }
    }
    this.upgradingAll = false;
  }

  async uninstall(entry: InstalledEntry): Promise<void> {
    if (!this.manifest || !this.manifestFileId || this.actionLoading) return;
    this.actionLoading = entry.packageName;
    try {
      this.manifest = await this.appStoreService.uninstallApp(
        entry.packageName,
        entry.installed,
        this.manifest,
        this.manifestFileId,
      );
      this.entries = this.entries.filter(e => e.packageName !== entry.packageName);
    } catch (e: any) {
      this.error = `Uninstall of ${entry.packageName} failed: ${e.message}`;
    } finally {
      this.actionLoading = null;
    }
  }
}
