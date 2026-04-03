import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { FeedConfig, DEFAULT_FEED_URL, FEED_NAME } from '../models/plugin-manager.models';
import { PluginManagerService } from '../services/plugin-manager.service';

@Component({
  selector: 'app-onboarding',
  standalone: false,
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss',
})
export class OnboardingComponent {
  step = 1;
  feedUrl = DEFAULT_FEED_URL;
  feedId = '';
  error = '';
  loading = false;

  // Feed-already-exists conflict state
  existingFeedId = '';
  existingFeedName = '';
  showFeedConflict = false;

  // Step 2 – optional additional feed
  optionalFeedUrl = '';
  optionalFeedName = '';
  addingOptional = false;

  constructor(
    private appStoreService: PluginManagerService,
    private router: Router,
  ) {}

  async replicateFeed(): Promise<void> {
    if (this.loading || !this.feedUrl.trim()) return;
    this.loading = true;
    this.error = '';
    this.showFeedConflict = false;
    try {
      const result = await this.appStoreService.replicateFeed(this.feedUrl.trim());
      this.feedId = result.id ?? result.feedId ?? '';
      await this.saveMainFeedAndAdvance();
    } catch (e: any) {
      const msg = typeof e.message === 'string' ? e.message : '';
      // Detect "feed already exists" style errors and offer to use the existing feed.
      if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('conflict')) {
        const existing = await this.appStoreService.findFeedBySourceUrl(this.feedUrl.trim());
        if (existing) {
          this.existingFeedId = existing.id;
          this.existingFeedName = existing.name;
          this.showFeedConflict = true;
        } else {
          this.error = `Feed replication failed: ${msg}`;
        }
      } else {
        this.error = `Feed replication failed: ${msg}`;
      }
    } finally {
      this.loading = false;
    }
  }

  /** User chose to use the existing feed that was already replicated. */
  async useExistingFeed(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.showFeedConflict = false;
    try {
      this.feedId = this.existingFeedId;
      await this.saveMainFeedAndAdvance();
    } catch (e: any) {
      this.error = `Failed to save feed configuration: ${e.message}`;
    } finally {
      this.loading = false;
    }
  }

  /** User chose to replace the existing feed with a fresh replication. */
  async replaceExistingFeed(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.showFeedConflict = false;
    try {
      await this.appStoreService.deleteReplicatedFeed(this.existingFeedId);
      const result = await this.appStoreService.replicateFeed(this.feedUrl.trim());
      this.feedId = result.id ?? result.feedId ?? '';
      await this.saveMainFeedAndAdvance();
    } catch (e: any) {
      this.error = `Failed to replace feed: ${e.message}`;
    } finally {
      this.loading = false;
    }
  }

  private async saveMainFeedAndAdvance(): Promise<void> {
    const mainFeedConfig: FeedConfig = {
      name: FEED_NAME,
      url: this.feedUrl.trim(),
      feedId: this.feedId,
    };
    const existing = await this.appStoreService.loadFeedConfigs();
    const updated = [...existing.filter(f => f.feedId !== this.feedId), mainFeedConfig];
    await this.appStoreService.saveFeedConfigs(updated);
    // Tag the Plugin Manager's own webapp so it appears as installed in the catalog.
    await this.appStoreService.tagOwnWebapp(this.feedId, this.feedUrl.trim());
    this.step = 2;
  }

  async addOptionalFeed(): Promise<void> {
    if (this.addingOptional || !this.optionalFeedUrl.trim()) return;
    this.addingOptional = true;
    this.error = '';
    try {
      const result = await this.appStoreService.replicateFeed(this.optionalFeedUrl.trim());
      const optFeedId = result.id ?? result.feedId ?? '';
      const feedConfig: FeedConfig = {
        name: this.optionalFeedName.trim() || 'Additional Feed',
        url: this.optionalFeedUrl.trim(),
        feedId: optFeedId,
      };
      const existing = await this.appStoreService.loadFeedConfigs();
      const updated = [...existing.filter(f => f.feedId !== optFeedId), feedConfig];
      await this.appStoreService.saveFeedConfigs(updated);
      this.step = 3;
    } catch (e: any) {
      this.error = `Failed to add feed: ${e.message}`;
    } finally {
      this.addingOptional = false;
    }
  }

  skipAdditionalFeed(): void {
    this.step = 3;
  }

  goToCatalog(): void {
    this.router.navigate(['/catalog']);
  }
}

