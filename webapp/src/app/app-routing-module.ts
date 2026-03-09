import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { CatalogComponent } from './catalog/catalog.component';
import { AppDetailComponent } from './detail/detail.component';
import { InstalledComponent } from './installed/installed.component';
import { SettingsComponent } from './settings/settings.component';
import { OnboardingComponent } from './onboarding/onboarding.component';

const routes: Routes = [
  { path: '', redirectTo: 'catalog', pathMatch: 'full' },
  { path: 'catalog', component: CatalogComponent },
  { path: 'catalog/:packageName', component: AppDetailComponent },
  { path: 'installed', component: InstalledComponent },
  { path: 'settings', component: SettingsComponent },
  { path: 'onboarding', component: OnboardingComponent },
];

@NgModule({
  imports: [RouterModule.forRoot(routes, { useHash: true })],
  exports: [RouterModule]
})
export class AppRoutingModule { }
