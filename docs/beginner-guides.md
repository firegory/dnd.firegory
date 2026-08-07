# Beginner guides and compendium landing

Authenticated users enter the 2024 compendium at `/ru/compendium` or `/en/compendium`. The sidebar language control keeps the current compendium deep link while switching locale. The landing page only renders category tiles returned by the source-authorized `CompendiumReadService` query and guide tiles allowed by `canReadGuide`; inaccessible category and guide routes return the same not-found response as missing content.

The `starter`, `basics`, and `character-creation` routes use the shared parchment `AppLayout`. Guide documents are controlled discriminated-union blocks, not HTML. React renders only paragraphs, callouts, lists, and steps. Every block carries visible attribution and an expandable source citation; print CSS expands citation details and removes application chrome. The character-creation guide is currently premium/admin material, while starter and basics are open to authenticated roles.

## Collected article boundary

`extractSnapshotGuideForReview` accepts a content-addressed collector run directory plus a category/external ID. It reads `manifest.json`, verifies the manifest hash against the run-directory name, rehashes the referenced blob, selects explicit unambiguous spans from that detail's sanitized `contentText`, and records Unicode code-point offsets plus the manifest identity, blob path/hash, source/final URLs, fetch metadata, and parser version. Callers cannot provide URL, hash, parser output, or blob provenance independently. `feedSnapshotGuideToImportRun` writes the immutable collector occurrence through #75 `recordOccurrences`, then sends a non-null `guide` candidate through `computeCandidateDiff` for pending #76 review. It intentionally stores no `contentHtml`, does not create a guide document, and has no publication side effect. An editor must review and deliberately transfer approved text into the controlled guide schema; collected HTML is never a publication format.

Migration `0014_compendium_guide_candidate_type.sql` adds only the `guide` enum discriminator required by durable import candidates. Guides remain version-controlled application content, category visibility uses the existing compendium index and centralized source authorization, and embeddings are not read or changed by these routes.

Localized entry links use canonical entry UUIDs rather than localized slugs, so RU/EN switches resolve the matching accessible version. Locale switching retains query and hash state. Middleware provides the locale to the root layout for server-rendered `<html lang>`, and authenticated redirects carry a validated local `next` destination through the login form and action. Absolute, protocol-relative, credentialed, control-character, and backslash-based redirect attempts fall back to `/`.

Compendium entry citations show quote, source, page, and section. Preview links use the existing authenticated `/api/citations/preview` endpoint, which reapplies centralized source authorization; external source links are emitted only for credential-free HTTP(S) publication origins.

## Verification

Run all checks with Node.js 22:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Manual browser checks remain required at desktop width, 375 px mobile width, 200% zoom, and print preview in both locales. Verify keyboard focus, expanded citation disclosure, locale-preserving deep links, and the not-found response for inaccessible guide/category/entry URLs.
