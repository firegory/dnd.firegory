# Beginner guides and compendium landing

Authenticated users enter the 2024 compendium at `/ru/compendium` or `/en/compendium`. The sidebar language control keeps the current compendium deep link while switching locale. The landing page only renders category tiles returned by the source-authorized `CompendiumReadService` query and guide tiles allowed by `canReadGuide`; inaccessible category and guide routes return the same not-found response as missing content.

The `starter`, `basics`, and `character-creation` routes use the shared parchment `AppLayout`. Guide documents are controlled discriminated-union blocks, not HTML. React renders only paragraphs, callouts, lists, and steps. Every block carries visible attribution and an expandable source citation; print CSS expands citation details and removes application chrome. The character-creation guide is currently premium/admin material, while starter and basics are open to authenticated roles.

## Collected article boundary

`extractSnapshotGuideForReview` selects explicit, unambiguous spans from the parser's sanitized `contentText` and records Unicode code-point offsets plus immutable snapshot provenance. `snapshotGuideReviewBatch` converts that result into a pending issue #76 import candidate and occurrence. It intentionally stores no `contentHtml`, does not create a guide document, and has no publication side effect. An editor must review and deliberately transfer approved text into the controlled guide schema; collected HTML is never a publication format.

No migration is required. Guides are version-controlled application content, category visibility uses the existing compendium index and centralized source authorization, and embeddings are not read or changed by these routes.

## Verification

Run all checks with Node.js 22:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Manual browser checks remain required at desktop width, 375 px mobile width, 200% zoom, and print preview in both locales. Verify keyboard focus, expanded citation disclosure, locale-preserving deep links, and the not-found response for inaccessible guide/category/entry URLs.
