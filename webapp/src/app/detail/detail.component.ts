import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AppPackage, FeedConfig, InstalledApp, WorkspaceInfo, WorkspaceInstallation } from '../models/plugin-manager.models';
import { PluginManagerService } from '../services/plugin-manager.service';
import { formatBytes } from '../utils/semver';
import { isNewerVersion } from '../utils/semver';

interface WorkspaceInstallOption {
  workspaceId: string;
  workspaceName: string;
  isCurrentWorkspace: boolean;
  alreadyInstalled: boolean;
}

@Component({
  selector: 'app-detail',
  standalone: false,
  templateUrl: './detail.component.html',
  styleUrl: './detail.component.scss',
})
export class AppDetailComponent implements OnInit {
  pkg: AppPackage | null = null;
  /** Installation record for the current workspace (null if not installed here). */
  installed: InstalledApp | null = null;
  feedId: string | null = null;
  feedConfig: FeedConfig | null = null;
  currentWorkspace = '';
  /** All installations of this package across all visible workspaces. */
  workspaceInstallations: WorkspaceInstallation[] = [];
  installOptions: WorkspaceInstallOption[] = [];
  pendingWorkspaceIds: string[] = [];
  isEditMode = false;
  private originalInstalledIds = new Set<string>();
  private allInstallations: WorkspaceInstallation[] = [];

  @ViewChild('installDialog') private installDialogEl?: ElementRef;
  @ViewChild('confirmDialog') private confirmDialogEl?: ElementRef;
  @ViewChild('workspaceSelect') private workspaceSelectEl?: ElementRef;

  hasPermission = true;
  loading = true;
  actionLoading = false;
  error = '';

  constructor(
    private route: ActivatedRoute,
    private appStoreService: PluginManagerService,
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

      this.currentWorkspace = await this.appStoreService.getWorkspace();

      let readableWorkspaces: WorkspaceInfo[] = [];
      try {
        readableWorkspaces = await this.appStoreService.listReadableWorkspaces();
      } catch {
        readableWorkspaces = [];
      }

      // Load feed configs, installed webapps, and workspaces in parallel
      const [feedConfigs, allInstallations] = await Promise.all([
        this.appStoreService.loadFeedConfigs(),
        this.appStoreService.listInstalledWebapps(),
      ]);
      this.allInstallations = allInstallations;

      // Derive feed info
      this.feedId = feedConfigs[0]?.feedId ?? null;
      this.feedConfig = feedConfigs[0] ?? null;

      // Discover feed if not configured
      if (feedConfigs.length === 0) {
        const feed = await this.appStoreService.discoverFeed();
        if (feed) { this.feedId = feed.id; this.feedConfig = null; }
      }

      if (feedConfigs.length === 0 && !this.feedId) {
        this.error = 'Feed not found. Please complete onboarding first.';
        return;
      }

      // Load packages from ALL configured feeds and find by packageName
      const packages = feedConfigs.length > 0
        ? await this.appStoreService.listPackagesFromFeeds(feedConfigs)
        : await this.appStoreService.listPackages(this.feedId!);
      this.pkg = packages.find(p => p.packageName === packageName) ?? null;

      if (!this.pkg) {
        this.error = `Package "${packageName}" not found in the catalog.`;
        return;
      }

      this.refreshWorkspaceState(packageName, readableWorkspaces);
    } catch (e: any) {
      this.error = e.message ?? 'Failed to load package details';
    } finally {
      this.loading = false;
    }
  }

  get upgradeAvailable(): boolean {
    return !!this.installed && !!this.pkg && isNewerVersion(this.pkg.version, this.installed.version);
  }

  get formattedSize(): string {
    return this.pkg ? formatBytes(this.pkg.size) : '';
  }

  get installedSomewhere(): boolean {
    return this.workspaceInstallations.length > 0;
  }

  get installableWorkspaces(): WorkspaceInstallOption[] {
    return this.installOptions.filter(option => !option.alreadyInstalled);
  }

  get selectableOptions(): WorkspaceInstallOption[] {
    const pending = new Set(this.pendingWorkspaceIds);
    return this.installOptions.filter(option => !pending.has(option.workspaceId));
  }

  get applyActionLabel(): string {
    if (this.actionLoading) return 'Applying…';
    if (!this.isEditMode) {
      const count = this.pendingWorkspaceIds.length;
      return count === 1 ? 'Install to 1 Workspace' : `Install to ${count} Workspaces`;
    }
    const toInstall = this.pendingWorkspaceIds.filter(id => !this.originalInstalledIds.has(id));
    const toRemove = [...this.originalInstalledIds].filter(id => !this.pendingWorkspaceIds.includes(id));
    const parts: string[] = [];
    if (toInstall.length) parts.push(`Add ${toInstall.length}`);
    if (toRemove.length) parts.push(`Remove ${toRemove.length}`);
    return parts.length ? parts.join(', ') : 'Apply';
  }

  get applyDisabled(): boolean {
    if (this.actionLoading) return true;
    if (!this.isEditMode) return this.pendingWorkspaceIds.length === 0;
    const toInstall = this.pendingWorkspaceIds.filter(id => !this.originalInstalledIds.has(id));
    const toRemove = [...this.originalInstalledIds].filter(id => !this.pendingWorkspaceIds.includes(id));
    return toInstall.length === 0 && toRemove.length === 0;
  }

  getResourceUrl(installation: WorkspaceInstallation): string {
    if (installation.type === 'notebook') {
      return `/jupyter/`;
    } else if (installation.type === 'dashboard') {
      return `/dashboardhost/d/${encodeURIComponent(installation.webappId)}`;
    }
    // webapp: /webapps/app/{workspace-name}/{webapp-name}
    const ws = encodeURIComponent(installation.workspaceName);
    const name = encodeURIComponent(installation.resourceName || installation.packageName);
    return `/webapps/app/${ws}/${name}`;
  }

  get installedWorkspaceNames(): string {
    return this.workspaceInstallations.map(installation => installation.workspaceName).join(', ');
  }

  openInstallDialog(): void {
    if (!this.pkg) return;

    this.isEditMode = this.installedSomewhere;
    this.originalInstalledIds = new Set(this.workspaceInstallations.map(i => i.workspaceId));

    if (this.isEditMode) {
      // Pre-populate with all currently installed workspaces
      this.pendingWorkspaceIds = this.workspaceInstallations.map(i => i.workspaceId);
    } else {
      // Pre-select current workspace if installable, otherwise nothing
      const currentOption = this.installableWorkspaces.find(o => o.isCurrentWorkspace);
      this.pendingWorkspaceIds = currentOption ? [currentOption.workspaceId] : [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.installDialogEl?.nativeElement as any)?.show();
  }

  closeInstallDialog(): void {
    if (this.actionLoading) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.installDialogEl?.nativeElement as any)?.close();
  }

  onWorkspaceSelected(event: Event): void {
    const select = event.target as HTMLElement & { value: string };
    const id = select.value;
    if (id && !this.pendingWorkspaceIds.includes(id)) {
      this.pendingWorkspaceIds = [...this.pendingWorkspaceIds, id];
    }
    // Reset select back to placeholder
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.workspaceSelectEl?.nativeElement as any).value = '';
  }

  removeWorkspace(id: string): void {
    this.pendingWorkspaceIds = this.pendingWorkspaceIds.filter(w => w !== id);
  }

  getWorkspaceName(id: string): string {
    return this.installOptions.find(o => o.workspaceId === id)?.workspaceName ?? id;
  }

  isCurrentWorkspace(id: string): boolean {
    return this.installOptions.find(o => o.workspaceId === id)?.isCurrentWorkspace ?? false;
  }

  isAlreadyInstalled(id: string): boolean {
    return this.originalInstalledIds.has(id);
  }

  async applyWorkspaceChanges(): Promise<void> {
    if (!this.pkg || this.actionLoading) return;
    const feedId = this.pkg.sourceFeedId ?? this.feedId;
    if (!feedId) return;
    const pkgType = (this.pkg.type || 'webapp').toLowerCase();
    const feedConfig = this.feedConfig?.feedId === feedId
      ? this.feedConfig
      : null;
    const toInstallIds = this.pendingWorkspaceIds.filter(id => !this.originalInstalledIds.has(id));
    const toUninstall = this.workspaceInstallations.filter(inst => !this.pendingWorkspaceIds.includes(inst.workspaceId));
    this.actionLoading = true;
    this.error = '';
    try {
      if (toInstallIds.length > 0) {
        if (pkgType === 'dashboard' && this.isEditMode && this.workspaceInstallations.length > 0) {
          const sourceInstallation = this.installed?.type === 'dashboard'
            ? this.installed
            : this.workspaceInstallations.find(installation => installation.type === 'dashboard');
          if (!sourceInstallation) {
            throw new Error('No existing dashboard installation is available to duplicate');
          }
          await this.appStoreService.duplicateDashboardAcrossWorkspaces(sourceInstallation.webappId, toInstallIds);
        } else {
          await this.appStoreService.installAppAcrossWorkspaces(
            feedId,
            this.pkg,
            toInstallIds,
            feedConfig,
          );
        }
      }
      if (toUninstall.length > 0) {
        await this.appStoreService.uninstallAppAcrossWorkspaces(toUninstall);
      }
      await this.reloadWorkspaceState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.installDialogEl?.nativeElement as any)?.close();
    } catch (e: any) {
      this.error = `Operation failed: ${e.message}`;
    } finally {
      this.actionLoading = false;
    }
  }

  async upgrade(): Promise<void> {
    if (!this.pkg || !this.installed || this.actionLoading) return;
    const feedId = this.pkg.sourceFeedId ?? this.feedId;
    if (!feedId) return;
    this.actionLoading = true;
    this.error = '';
    try {
      await this.appStoreService.upgradeApp(feedId, this.pkg, this.installed);
      await this.reloadWorkspaceState();
    } catch (e: any) {
      this.error = `Upgrade failed: ${e.message}`;
    } finally {
      this.actionLoading = false;
    }
  }

  openUninstallDialog(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.confirmDialogEl?.nativeElement as any)?.show();
  }

  closeUninstallDialog(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.confirmDialogEl?.nativeElement as any)?.close();
  }

  async uninstall(): Promise<void> {
    if (!this.pkg || !this.workspaceInstallations.length || this.actionLoading) return;
    this.actionLoading = true;
    this.error = '';
    this.closeUninstallDialog();
    try {
      await this.appStoreService.uninstallAppAcrossWorkspaces(this.workspaceInstallations);
      await this.reloadWorkspaceState();
    } catch (e: any) {
      this.error = `Uninstall failed: ${e.message}`;
    } finally {
      this.actionLoading = false;
    }
  }

  trackWorkspaceById(_: number, option: WorkspaceInstallOption): string {
    return option.workspaceId;
  }

  private async reloadWorkspaceState(): Promise<void> {
    if (!this.pkg) return;

    let readableWorkspaces: WorkspaceInfo[] = [];
    try {
      readableWorkspaces = await this.appStoreService.listReadableWorkspaces();
    } catch {
      readableWorkspaces = [];
    }

    this.allInstallations = await this.appStoreService.listInstalledWebapps();
    this.refreshWorkspaceState(this.pkg.packageName, readableWorkspaces);
  }

  private refreshWorkspaceState(packageName: string, readableWorkspaces: WorkspaceInfo[]): void {
    const installations = this.allInstallations
      .filter(inst => inst.packageName === packageName)
      .sort((left, right) => {
        if (left.isCurrentWorkspace !== right.isCurrentWorkspace) {
          return left.isCurrentWorkspace ? -1 : 1;
        }
        return left.workspaceName.localeCompare(right.workspaceName);
      });

    this.workspaceInstallations = installations;
    this.installed = installations.find(i => i.isCurrentWorkspace) ?? null;

    const installedWorkspaceIds = new Set(installations.map(i => i.workspaceId));

    this.installOptions = readableWorkspaces.map(workspace => ({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      isCurrentWorkspace: workspace.id === this.currentWorkspace,
      alreadyInstalled: installedWorkspaceIds.has(workspace.id),
    })).sort((left, right) => {
      if (left.isCurrentWorkspace !== right.isCurrentWorkspace) {
        return left.isCurrentWorkspace ? -1 : 1;
      }
      return left.workspaceName.localeCompare(right.workspaceName) || left.workspaceId.localeCompare(right.workspaceId);
    });

    if (!this.installOptions.length && this.currentWorkspace) {
      this.installOptions = [{
        workspaceId: this.currentWorkspace,
        workspaceName: this.currentWorkspace,
        isCurrentWorkspace: true,
        alreadyInstalled: installedWorkspaceIds.has(this.currentWorkspace),
      }];
    }
  }
}
