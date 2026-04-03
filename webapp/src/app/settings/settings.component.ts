import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { PLUGIN_MANAGER_VERSION, FeedConfig, DEFAULT_FEED_URL } from '../models/plugin-manager.models';
import { PluginManagerService } from '../services/plugin-manager.service';

@Component({
  selector: 'app-settings',
  standalone: false,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  @ViewChild('addFeedDialog') private addFeedDialogEl?: ElementRef;
  @ViewChild('removeFeedDialog') private removeFeedDialogEl?: ElementRef;

  feeds: FeedConfig[] = [];
  installedCount = 0;
  readonly version = PLUGIN_MANAGER_VERSION;

  loading = true;
  refreshingFeedId: string | null = null;
  refreshResult = '';
  error = '';

  // Add-feed form
  addFeedUrl = '';
  addFeedName = '';
  addingFeed = false;
  feedPendingRemoval: FeedConfig | null = null;
  deleteReplicatedFeedOnRemove = true;
  removingFeed = false;

  constructor(
    private appStoreService: PluginManagerService,
    public router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      const [feedConfigs, installations] = await Promise.all([
        this.appStoreService.loadFeedConfigs(),
        this.appStoreService.listInstalledWebapps().catch(() => [] as any[]),
      ]);
      this.feeds = feedConfigs;
      this.installedCount = installations.length;
    } catch (e: any) {
      this.error = e.message ?? 'Failed to load settings';
    } finally {
      this.loading = false;
    }
  }

  get hasFeedConfig(): boolean {
    return this.feeds.length > 0;
  }

  async refreshFeed(feed: FeedConfig): Promise<void> {
    if (this.refreshingFeedId) return;
    this.refreshingFeedId = feed.feedId;
    this.refreshResult = '';
    this.error = '';
    try {
      const resourceIds = await this.appStoreService.checkForUpdates(feed.feedId);
      await this.appStoreService.applyUpdates(feed.feedId, resourceIds);
      this.refreshResult = resourceIds.length > 0
        ? `Feed "${feed.name}" refreshed successfully.`
        : `Feed "${feed.name}" is already up to date.`;
    } catch (e: any) {
      this.error = `Feed refresh failed: ${e.message}`;
    } finally {
      this.refreshingFeedId = null;
    }
  }

  async addFeed(): Promise<void> {
    if (this.addingFeed || !this.addFeedUrl.trim() || !this.addFeedName.trim()) return;
    this.addingFeed = true;
    this.error = '';
    try {
      const name = this.addFeedName.trim();
      const result = await this.appStoreService.replicateFeed(this.addFeedUrl.trim(), name);
      const feedId = result.id ?? result.feedId ?? '';
      const feedConfig: FeedConfig = {
        name,
        url: this.addFeedUrl.trim(),
        feedId,
      };
      const updated = [...this.feeds.filter(f => f.feedId !== feedId), feedConfig];
      await this.appStoreService.saveFeedConfigs(updated);
      this.feeds = updated;
      this.addFeedUrl = '';
      this.addFeedName = '';
      this.closeAddFeedDialog();
    } catch (e: any) {
      this.error = `Failed to add feed: ${e.message}`;
    } finally {
      this.addingFeed = false;
    }
  }

  openAddFeedDialog(): void {
    this.addFeedUrl = DEFAULT_FEED_URL;
    this.addFeedName = '';
    this.error = '';
    (this.addFeedDialogEl?.nativeElement as any)?.show();
  }

  closeAddFeedDialog(): void {
    (this.addFeedDialogEl?.nativeElement as any)?.close();
  }

  openRemoveFeedDialog(feed: FeedConfig): void {
    this.feedPendingRemoval = feed;
    this.deleteReplicatedFeedOnRemove = true;
    (this.removeFeedDialogEl?.nativeElement as any)?.show();
  }

  closeRemoveFeedDialog(force = false): void {
    if (this.removingFeed && !force) return;
    (this.removeFeedDialogEl?.nativeElement as any)?.close();
    this.feedPendingRemoval = null;
    this.deleteReplicatedFeedOnRemove = true;
  }

  async removeFeed(): Promise<void> {
    if (!this.feedPendingRemoval || this.removingFeed) return;

    this.error = '';
    this.removingFeed = true;
    const feedToRemove = this.feedPendingRemoval;

    try {
      if (this.deleteReplicatedFeedOnRemove && feedToRemove.feedId) {
        await this.appStoreService.deleteReplicatedFeed(feedToRemove.feedId);
      }

      const updated = this.feeds.filter(f => f.feedId !== feedToRemove.feedId);
      await this.appStoreService.saveFeedConfigs(updated);
      this.feeds = updated;
      this.closeRemoveFeedDialog(true);
    } catch (e: any) {
      this.error = `Failed to remove feed: ${e.message}`;
    } finally {
      this.removingFeed = false;
    }
  }

  isRefreshing(feed: FeedConfig): boolean {
    return this.refreshingFeedId === feed.feedId;
  }

  isDefaultFeed(feed: FeedConfig): boolean {
    return this.normalizeFeedUrl(feed.url) === this.normalizeFeedUrl(DEFAULT_FEED_URL);
  }

  private normalizeFeedUrl(url: string): string {
    return url.trim().replace(/\/+$/, '').toLowerCase();
  }
}

