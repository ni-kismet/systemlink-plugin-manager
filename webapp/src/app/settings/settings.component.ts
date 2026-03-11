import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FeedConfig, DEFAULT_FEED_URL, FEED_NAME } from '../models/app-store.models';
import { AppStoreService } from '../services/app-store.service';

@Component({
  selector: 'app-settings',
  standalone: false,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  feeds: FeedConfig[] = [];
  installedCount = 0;

  loading = true;
  refreshingFeedId: string | null = null;
  refreshResult = '';
  error = '';

  // Add-feed form
  addFeedUrl = '';
  addFeedName = '';
  addingFeed = false;

  constructor(
    private appStoreService: AppStoreService,
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
    if (this.addingFeed || !this.addFeedUrl.trim()) return;
    this.addingFeed = true;
    this.error = '';
    try {
      const result = await this.appStoreService.replicateFeed(this.addFeedUrl.trim());
      const feedId = result.id ?? result.feedId ?? '';
      const feedConfig: FeedConfig = {
        name: this.addFeedName.trim() || FEED_NAME,
        url: this.addFeedUrl.trim(),
        feedId,
      };
      const updated = [...this.feeds.filter(f => f.feedId !== feedId), feedConfig];
      await this.appStoreService.saveFeedConfigs(updated);
      this.feeds = updated;
      this.addFeedUrl = '';
      this.addFeedName = '';
    } catch (e: any) {
      this.error = `Failed to add feed: ${e.message}`;
    } finally {
      this.addingFeed = false;
    }
  }

  async removeFeed(feed: FeedConfig): Promise<void> {
    this.error = '';
    try {
      const updated = this.feeds.filter(f => f.feedId !== feed.feedId);
      await this.appStoreService.saveFeedConfigs(updated);
      this.feeds = updated;
    } catch (e: any) {
      this.error = `Failed to remove feed: ${e.message}`;
    }
  }

  isRefreshing(feed: FeedConfig): boolean {
    return this.refreshingFeedId === feed.feedId;
  }
}

