import { NgModule, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { APP_BASE_HREF } from '@angular/common';

import {
  NimbleThemeProviderModule,
  NimbleButtonModule,
  NimbleTextFieldModule,
  NimbleSelectModule,
  NimbleListOptionModule,
  NimbleDrawerModule,
  NimbleSpinnerModule,
  NimbleBannerModule,
  NimbleTabsModule,
  NimbleTabModule,
  NimbleTabPanelModule,
  NimbleDialogModule,
  NimbleMenuButtonModule,
  NimbleMenuModule,
  NimbleMenuItemModule,
  NimbleToolbarModule,
  NimbleAnchorButtonModule,
  NimbleAnchorTabsModule,
  NimbleAnchorTabModule,
  NimbleIconMagnifyingGlassModule,
} from '@ni/nimble-angular';
import { NimbleLabelProviderCoreModule } from '@ni/nimble-angular/label-provider/core';
import { NimbleCardModule } from '@ni/nimble-angular/card';

import { AppRoutingModule } from './app-routing-module';
import { App } from './app';
import { CatalogComponent } from './catalog/catalog.component';
import { AppDetailComponent } from './detail/detail.component';
import { InstalledComponent } from './installed/installed.component';
import { SettingsComponent } from './settings/settings.component';
import { OnboardingComponent } from './onboarding/onboarding.component';
import { AppCardComponent } from './catalog/app-card.component';
import { PermissionBannerComponent } from './shared/permission-banner.component';

@NgModule({
  declarations: [
    App,
    CatalogComponent,
    AppDetailComponent,
    InstalledComponent,
    SettingsComponent,
    OnboardingComponent,
    AppCardComponent,
    PermissionBannerComponent,
  ],
  imports: [
    BrowserModule,
    FormsModule,
    AppRoutingModule,
    NimbleThemeProviderModule,
    NimbleLabelProviderCoreModule,
    NimbleButtonModule,
    NimbleTextFieldModule,
    NimbleSelectModule,
    NimbleListOptionModule,
    NimbleDrawerModule,
    NimbleSpinnerModule,
    NimbleBannerModule,
    NimbleTabsModule,
    NimbleTabModule,
    NimbleTabPanelModule,
    NimbleDialogModule,
    NimbleCardModule,
    NimbleMenuButtonModule,
    NimbleMenuModule,
    NimbleMenuItemModule,
    NimbleToolbarModule,
    NimbleAnchorButtonModule,
    NimbleAnchorTabsModule,
    NimbleAnchorTabModule,
    NimbleIconMagnifyingGlassModule,
  ],
  providers: [
    { provide: APP_BASE_HREF, useValue: '/' },
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  bootstrap: [App]
})
export class AppModule { }
