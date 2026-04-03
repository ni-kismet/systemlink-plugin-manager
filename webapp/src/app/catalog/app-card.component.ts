import { Component, Input, Output, EventEmitter } from '@angular/core';
import { AppPackage } from '../models/plugin-manager.models';

@Component({
  selector: 'app-card',
  standalone: false,
  template: `
    <div class="app-card" (click)="selected.emit(pkg)">
      <div class="card-icon">
        <img *ngIf="pkg.icon" [src]="pkg.icon" alt="" class="icon-img" />
        <div *ngIf="!pkg.icon" class="icon-placeholder">{{ pkg.displayName.charAt(0) }}</div>
      </div>
      <div class="card-body">
        <div class="card-header">
          <span class="card-title">{{ pkg.displayName }}</span>
          <span *ngIf="upgradeAvailable" class="upgrade-badge">Update</span>
          <span *ngIf="installed && !upgradeAvailable" class="installed-badge">Installed</span>
        </div>
        <span class="card-author">{{ pkg.author }}</span>
        <span class="card-description">{{ pkg.description | slice:0:120 }}{{ pkg.description.length > 120 ? '…' : '' }}</span>
        <div class="card-footer">
          <span class="card-type" *ngIf="pkg.type && pkg.type !== 'webapp'">{{ pkg.type }}</span>
          <span class="card-category">{{ pkg.category }}</span>
          <span class="card-version">v{{ pkg.version }}</span>
        </div>
      </div>
    </div>
  `,
  styleUrl: './app-card.component.scss',
})
export class AppCardComponent {
  @Input() pkg!: AppPackage;
  @Input() installed = false;
  @Input() upgradeAvailable = false;
  @Output() selected = new EventEmitter<AppPackage>();
}
