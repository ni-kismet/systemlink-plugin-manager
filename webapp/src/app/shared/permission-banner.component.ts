import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-permission-banner',
  standalone: false,
  template: `
    <nimble-banner *ngIf="!hasPermission" severity="warning" [open]="true">
      You do not have permission to install or manage web applications.
      Contact your SystemLink administrator to request
      "Create, modify, and delete web applications" permissions.
      You can still browse the catalog in read-only mode.
    </nimble-banner>
  `,
})
export class PermissionBannerComponent {
  @Input() hasPermission = true;
}
