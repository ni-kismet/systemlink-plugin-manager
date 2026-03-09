# Upstream Fix: Missing performance warning on `queryAvailableFiles` in `nisystemlink-clients-ts`

## Context

Package: `nisystemlink-clients-ts` v1.0.0  
Generator: `@hey-api/openapi-ts` v0.94  
Affected file: `src/generated/file-ingestion/sdk.gen.ts`  
Source spec: `nifile.yaml` (SystemLink File Service)

## The bug

The generated `queryAvailableFiles` function is missing a critical performance warning
that exists in the source OpenAPI spec **and** is correctly present on its sibling
function `queryFilesLinq`.

### `queryFilesLinq` — correctly has the warning ✅

```typescript
/**
 * Query files linq
 *
 * Queries the SystemLink File service for a list of files that match specified metadata properties.
 * Note: Due to the performance of queries on un-indexed properties, filters that include custom properties are very likely to time out.
 */
export const queryFilesLinq = ...
```

### `queryAvailableFiles` — missing the warning ❌

```typescript
export const queryAvailableFiles = <ThrowOnError extends boolean = false>(
  options?: Options<QueryAvailableFilesData, ThrowOnError>
) => (options?.client ?? client).post<...>({
  url: '/v1/service-groups/Default/query-files',
  ...
});
```

The function has **no JSDoc at all**, despite the `nifile.yaml` spec containing:

```yaml
/v1/service-groups/Default/query-files:
  post:
    summary: Query files
    description: >-
      Queries the SystemLink File service for a list of files that match
      specified metadata properties.
      ...
      Note: Due to the performance of queries on un-indexed properties,
      filters that include custom properties are very likely to time out.
```

## Impact

Callers using `propertiesQuery` with custom (un-indexed) file properties get a
server-side timeout (HTTP 500) with no indication from the SDK that this is expected
behavior. The identical warning on `queryFilesLinq` correctly sets that expectation.

The `propertiesQuery` field in `QueryAvailableFilesData.body` is also missing any
corresponding warning in `types.gen.ts`:

```typescript
// current — no warning
propertiesQuery?: Array<PropertyQuery>;
```

## Requested fixes

### 1. Add JSDoc to `queryAvailableFiles` in `sdk.gen.ts`

Match the pattern already used for `queryFilesLinq`:

```typescript
/**
 * Query files
 *
 * Queries the SystemLink File service for a list of files that match
 * specified metadata properties.
 * Note: Due to the performance of queries on un-indexed properties,
 * filters that include custom properties are very likely to time out.
 */
export const queryAvailableFiles = ...
```

### 2. Add a `@remarks` warning to `propertiesQuery` in `types.gen.ts`

```typescript
/**
 * An array of queries for file properties.
 * @remarks Queries on custom (un-indexed) properties are very likely to time out
 * on the server. Prefer listing files with `listAvailableFilesGet` and filtering
 * client-side when querying custom properties.
 */
propertiesQuery?: Array<PropertyQuery>;
```

### 3. Root-cause investigation (code generation)

Determine why `@hey-api/openapi-ts` v0.94 dropped the `description` for
`/query-files` but preserved it for `/query-files-linq`. Both endpoints have the same
`description` structure in `nifile.yaml`. Likely causes:

- The `query-files` description contains a multi-item list before the `Note:` paragraph,
  which may have caused the generator to truncate or skip the description.
- The `query-files-linq` description is shorter and ends directly with the `Note:`.

If this is a generator issue, consider filing against `@hey-api/openapi-ts`. If it is
a spec formatting issue, reorder the `query-files` description so the `Note:` comes
first (or separately as `x-ni-remarks`).
