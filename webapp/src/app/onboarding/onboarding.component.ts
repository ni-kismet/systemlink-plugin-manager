import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { FeedConfig, DEFAULT_FEED_URL, FEED_NAME } from '../models/app-store.models';
import { AppStoreService } from '../services/app-store.service';

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

  constructor(
    private appStoreService: AppStoreService,
    private router: Router,
  ) {}

  async replicateFeed(): Promise<void> {
    if (this.loading || !this.feedUrl.trim()) return;
    this.loading = true;
    this.error = '';
    try {
      const result = await this.appStoreService.replicateFeed(this.feedUrl.trim());
      this.feedId = result.id ?? result.feedId ?? '';
      this.step = 2;
    } catch (e: any) {
      this.error = `Feed replication failed: ${e.message}`;
    } finally {
      this.loading = false;
    }
  }

  async saveFeedConfig(): Promise<void> {
    if (this.loading || !this.feedId) return;
    this.loading = true;
    this.error = '';
    try {
      const feedConfig: FeedConfig = {
        name: FEED_NAME,
        url: this.feedUrl.trim(),
        feedId: this.feedId,
      };
      const existing = await this.appStoreService.loadFeedConfigs();
      // Replace any existing entry for this feedId, then append the new one.
      const updated = [...existing.filter(f => f.feedId !== this.feedId), feedConfig];
      await this.appStoreService.saveFeedConfigs(updated);
      this.step = 3;
    } catch (e: any) {
      this.error = `Failed to save feed configuration: ${e.message}`;
    } finally {
      this.loading = false;
    }
  }

  goToCatalog(): void {
    this.router.navigate(['/catalog']);
  }
}

