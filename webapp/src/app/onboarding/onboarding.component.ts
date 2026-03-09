import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { DEFAULT_FEED_URL } from '../models/app-store.models';
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

  async createManifest(): Promise<void> {
    if (this.loading || !this.feedId) return;
    this.loading = true;
    this.error = '';
    try {
      const manifest = this.appStoreService.createEmptyManifest(this.feedId, this.feedUrl);
      await this.appStoreService.createManifest(manifest);
      this.step = 3;
    } catch (e: any) {
      this.error = `Manifest creation failed: ${e.message}`;
    } finally {
      this.loading = false;
    }
  }

  goToCatalog(): void {
    this.router.navigate(['/catalog']);
  }
}
