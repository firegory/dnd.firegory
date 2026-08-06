# Compendium Shell Verification

Manual checks supplement the pure navigation tests because this repository does not include a browser component-test runner.

## Visual and Responsive

- [ ] At 1596px and wider, the shell is centered, the desktop navigation is 238px wide, and normal content remains readable rather than stretching edge to edge.
- [ ] Admin source and table routes use the wide parchment variant.
- [ ] At 991px and narrower, the desktop sidebar is replaced by the sticky header and drawer trigger.
- [ ] At 375px, search, settings, sources, upload, and users remain reachable for the applicable role without page-level horizontal clipping.
- [ ] Users and processing-jobs tables scroll horizontally inside a visibly focusable region; columns and actions are not clipped from access.
- [ ] Browser print preview hides navigation, controls, dark chrome, and texture while retaining readable black-on-white content.

## Accessibility

- [ ] Landmarks are announced in order: header (mobile only), navigation, main. The drawer is announced as a modal dialog with a navigation label.
- [ ] The skip link is the first focusable control and moves focus to main content.
- [ ] Drawer trigger, close control, navigation links, and language options have accessible names and visible focus outlines.
- [ ] Opening the drawer moves focus inside it. Tab and Shift+Tab wrap within it. Escape and backdrop click close it and return focus to the trigger.
- [ ] Activating a drawer navigation link closes the drawer and lets Next.js move focus for the new route.
- [ ] Active navigation uses `aria-current="page"` and does not rely on color alone.
- [ ] Parchment text and controls meet WCAG AA contrast in a browser contrast checker; dark-shell muted text is checked at normal-text size.
- [ ] At 200% zoom and 320 CSS px width, content reflows and table regions remain keyboard-scrollable.

## Asset Provenance

No image, icon, font, or texture assets were added. The parchment grain, navigation marks, menu icon, and D20 wordmark are original CSS/HTML primitives implemented in this repository. There are no external asset requests or binary copies.
