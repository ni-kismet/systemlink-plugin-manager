# Nimble Angular — Template & Usage Reference

## nimble-theme-provider

Wrap your entire app. Always place at the root component level.

```html
<nimble-theme-provider [theme]="currentTheme">
  <router-outlet></router-outlet>
</nimble-theme-provider>
```

Themes: `light`, `dark`, `color` (high contrast).

For SystemLink-hosted apps, do not hard-code `theme="light"` unless the user explicitly wants a fixed theme. The common pattern is:

1. Detect initial theme from `?theme=...`, then the parent frame's `nimble-theme-provider`, then local storage, then system preference
2. If the app is hosted in a same-origin iframe, watch the parent provider's `theme` attribute with `MutationObserver` and update `currentTheme`
3. Define theme-aware CSS aliases such as colors and shadows on `nimble-theme-provider`, not on `:root`, so token resolution follows the active Nimble theme

When debugging theme mismatches, inspect resolved token values on the provider with `getComputedStyle(provider).getPropertyValue('--ni-nimble-application-background-color')` rather than only checking the `theme` attribute.

---

## nimble-table

Displays tabular data. Data must be an `Observable<TableRecord[]>` bound with `[data$]`.

### Module

```typescript
import { NimbleTableModule } from "@ni/nimble-angular/table";
```

### Row type requirement

Your row type must satisfy `TableRecord`. Add an index signature:

```typescript
interface MyRow {
  id: string;
  name: string;
  value: string | undefined;
  [key: string]: FieldValue | undefined; // required for TableRecord compatibility
}
```

### Template

```html
<nimble-table
  [data$]="rows$"
  id-field-name="id"
  selection-mode="single"
  (selection-change)="onSelectionChange($event)"
>
  <nimble-table-column-text field-name="name" column-id="col-name"
    >Name</nimble-table-column-text
  >

  <nimble-table-column-text field-name="value" column-id="col-value"
    >Value</nimble-table-column-text
  >
</nimble-table>
```

### Component wiring

```typescript
import { TableRecord, TableRowSelectionEventDetail } from '@ni/nimble-angular/table';
import { BehaviorSubject } from 'rxjs';

rows$ = new BehaviorSubject<MyRow[]>([]);

onSelectionChange(event: CustomEvent<TableRowSelectionEventDetail<MyRow>>): void {
  const selected = event.detail.selectedRecords[0];
  // ...
}
```

---

## nimble-table-column-text

Simple string column. Import: `NimbleTableColumnTextModule` from `@ni/nimble-angular/table-column/text`.

```html
<nimble-table-column-text field-name="myField" column-id="col-1">
  Column Header
</nimble-table-column-text>
```

---

## nimble-button

```typescript
import { NimbleButtonModule } from "@ni/nimble-angular/button";
```

```html
<!-- Default -->
<nimble-button (click)="doSomething()">Click Me</nimble-button>

<!-- Accent/primary style -->
<nimble-button
  appearance="block"
  appearance-variant="accent"
  (click)="doSomething()"
>
  Primary Action
</nimble-button>

<!-- Ghost / low-emphasis -->
<nimble-button appearance="ghost" (click)="cancel()">Cancel</nimble-button>
```

> **Note:** `appearance="accent"` is NOT valid. Use `appearance="block" appearance-variant="accent"`.

---

## nimble-text-field

```typescript
import { NimbleTextFieldModule } from "@ni/nimble-angular/text-field";
```

```html
<nimble-text-field
  [(ngModel)]="filterValue"
  placeholder="Enter filter..."
  (change)="onFilterChange()"
>
  Filter
</nimble-text-field>
```

---

## nimble-select + nimble-list-option

```typescript
import { NimbleSelectModule } from "@ni/nimble-angular/select";
import { NimbleListOptionModule } from "@ni/nimble-angular/list-option";
```

```html
<nimble-select [(ngModel)]="selectedType" (change)="onTypeChange()">
  <nimble-list-option value="">All types</nimble-list-option>
  <nimble-list-option value="DOUBLE">Double</nimble-list-option>
  <nimble-list-option value="STRING">String</nimble-list-option>
  <nimble-list-option value="BOOLEAN">Boolean</nimble-list-option>
</nimble-select>
```

---

## nimble-drawer

Side panel for details or config. Control with `#drawerRef` template variable.

```typescript
import { NimbleDrawerModule } from "@ni/nimble-angular/drawer";
```

```html
<nimble-drawer #detailDrawer location="right">
  <h3 slot="header">Detail</h3>
  <div>{{ selectedItem?.name }}</div>
  <nimble-button slot="footer" (click)="detailDrawer.hide()"
    >Close</nimble-button
  >
</nimble-drawer>

<nimble-button (click)="detailDrawer.show()">Open Detail</nimble-button>
```

---

## nimble-spinner

```typescript
import { NimbleSpinnerModule } from "@ni/nimble-angular/spinner";
```

```html
<nimble-spinner *ngIf="loading"></nimble-spinner>
```

---

## nimble-banner

For in-page error/warning/info messages.

```typescript
import { NimbleBannerModule } from "@ni/nimble-angular/banner";
```

```html
<nimble-banner *ngIf="error" severity="error" [open]="!!error">
  {{ error }}
</nimble-banner>
```

---

## Layout patterns

Nimble doesn't ship a grid/layout component. Use flexbox in SCSS:

```scss
// component.scss
:host {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  box-sizing: border-box;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.table-container {
  flex: 1;
  min-height: 0; // important — lets flex child shrink below its content height
}

nimble-table {
  height: 100%;
}
```
