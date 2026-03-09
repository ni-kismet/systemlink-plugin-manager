import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { InstallManifest } from '../models/app-store.models';
import { AppStoreService } from '../services/app-store.service';

@Component({
  selector: 'app-settings',
  standalone: false,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  manifest: InstallManifest | null = null;
  manifestFileId: string | null = null;

  loading = true;
  refreshing = false;
  refreshResult = '';
  error = '';

  constructor(
    private appStoreService: AppStoreService,
    public router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      const result = await this.appStoreService.findManifest();
      if (result) {
        this.manifest = result.manifest;
        this.manifestFileId = result.fileId;
      }
    } catch (e: any) {
      this.error = e.message ?? 'Failed to load settings';
    } finally {
      this.loading = false;
    }
  }

  get feedName(): string {
    return this.manifest?.config.feedName ?? '—';
  }

  get feedUrl(): string {
    return this.manifest?.config.githubFeedUrl ?? '—';
  }

  get feedId(): string {
    return this.manifest?.config.feedId ?? '—';
  }

  get installedCount(): number {
    return this.manifest ? Object.keys(this.manifest.installedApps).length : 0;
  }

  async refreshFeed(): Promise<void> {
    if (!this.manifest?.config.feedId || this.refreshing) return;
    this.refreshing = true;
    this.refreshResult = '';
    this.error = '';
    try {
      await this.appStoreService.checkForUpdates(this.manifest.config.feedId);
      await this.appStoreService.applyUpdates(this.manifest.config.feedId);
      this.refreshResult = 'Feed refreshed successfully.';
    } catch (e: any) {
      this.error = `Feed refresh failed: ${e.message}`;
    } finally {
      this.refreshing = false;
    }
  }
}
