import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AppPackage, WorkspaceInstallation } from '../models/app-store.models';
import { AppStoreService } from '../services/app-store.service';
import { compareSemver, isNewerVersion } from '../utils/semver';

interface InstalledEntry {
  packageName: string;
  installations: WorkspaceInstallation[];
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
    await this.loadInstalledApps();
  }

  get upgradesAvailable(): number {
    return this.entries.filter(entry => entry.upgradeAvailable).length;
  }

  openDetail(entry: InstalledEntry): void {
    this.router.navigate(['/catalog', entry.packageName]);
  }

  getInstalledVersionLabel(entry: InstalledEntry): string {
    const versions = [...new Set(entry.installations.map(installation => installation.version))]
      .sort((left, right) => compareSemver(right, left));

    if (versions.length === 1) {
      return `v${versions[0]}`;
    }

    return versions.map(version => `v${version}`).join(', ');
  }

  getWorkspaceSummary(entry: InstalledEntry): string {
    const names = entry.installations.map(installation => installation.workspaceName);
    return `${names.length} workspace${names.length === 1 ? '' : 's'}`;
  }

  getLastActivity(entry: InstalledEntry): string {
    return entry.installations
      .map(installation => installation.updatedAt ?? installation.installedAt)
      .sort((left, right) => right.localeCompare(left))[0] ?? '';
  }

  async upgrade(entry: InstalledEntry): Promise<void> {
    if (!this.feedId || !entry.catalogPkg || this.actionLoading) return;
    this.actionLoading = entry.packageName;
    this.error = '';
    try {
      await this.appStoreService.upgradeAppAcrossWorkspaces(
        this.feedId,
        entry.catalogPkg,
        entry.installations,
      );
      await this.loadInstalledApps(false);
    } catch (e: any) {
      this.error = `Upgrade of ${entry.packageName} failed: ${e.message}`;
    } finally {
      this.actionLoading = null;
    }
  }

  async upgradeAll(): Promise<void> {
    if (!this.feedId || this.upgradingAll) return;
    this.upgradingAll = true;
    this.error = '';

    const upgradableEntries = this.entries.filter(entry => entry.upgradeAvailable && entry.catalogPkg);

    try {
      for (const entry of upgradableEntries) {
        await this.appStoreService.upgradeAppAcrossWorkspaces(
          this.feedId,
          entry.catalogPkg!,
          entry.installations,
        );
      }

      await this.loadInstalledApps(false);
    } catch (e: any) {
      this.error = `Upgrade all failed: ${e.message ?? e}`;
    } finally {
      this.upgradingAll = false;
    }
  }

  async uninstall(entry: InstalledEntry): Promise<void> {
    if (this.actionLoading) return;
    this.actionLoading = entry.packageName;
    this.error = '';
    try {
      await this.appStoreService.uninstallAppAcrossWorkspaces(entry.installations);
      await this.loadInstalledApps(false);
    } catch (e: any) {
      this.error = `Uninstall of ${entry.packageName} failed: ${e.message}`;
    } finally {
      this.actionLoading = null;
    }
  }

  private async loadInstalledApps(showSpinner = true): Promise<void> {
    if (showSpinner) {
      this.loading = true;
    }

    try {
      try {
        await this.appStoreService.listWebapps();
        this.hasPermission = true;
      } catch {
        this.hasPermission = false;
      }

      // Load feed configs and installed webapps in parallel
      const [feedConfigs, installations] = await Promise.all([
        this.appStoreService.loadFeedConfigs(),
        this.appStoreService.listInstalledWebapps(),
      ]);

      this.feedId = feedConfigs[0]?.feedId ?? null;

      // If no feed config, infer from installed webapps
      if (!this.feedId && installations.length > 0) {
        this.feedId = installations[0].feedId || null;
      }

      let catalogMap = new Map<string, AppPackage>();
      if (this.feedId) {
        const packages = await this.appStoreService.listPackages(this.feedId);
        for (const pkg of packages) {
          catalogMap.set(pkg.packageName, pkg);
        }
      }

      // Group installations by packageName
      const groupedInstallations = new Map<string, WorkspaceInstallation[]>();
      for (const installation of installations) {
        const list = groupedInstallations.get(installation.packageName) ?? [];
        list.push(installation);
        groupedInstallations.set(installation.packageName, list);
      }

      this.entries = [...groupedInstallations.entries()]
        .map(([packageName, pkgInstallations]) => {
          const catalogPkg = catalogMap.get(packageName) ?? null;
          return {
            packageName,
            installations: pkgInstallations.sort((left, right) => left.workspaceName.localeCompare(right.workspaceName)),
            catalogPkg,
            upgradeAvailable: !!catalogPkg && pkgInstallations.some(i => isNewerVersion(catalogPkg.version, i.version)),
          };
        })
        .sort((left, right) => {
          const leftName = left.catalogPkg?.displayName ?? left.packageName;
          const rightName = right.catalogPkg?.displayName ?? right.packageName;
          return leftName.localeCompare(rightName) || left.packageName.localeCompare(right.packageName);
        });
    } catch (e: any) {
      this.error = e.message ?? 'Failed to load installed apps';
    } finally {
      this.loading = false;
    }
  }
}
