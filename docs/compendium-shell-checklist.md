# Compendium Shell Verification

The repository has no browser automation dependency or browser binary. Native-dialog and focus-transfer behavior is therefore covered by DOM-oriented unit tests in `tests/ui/drawer-behavior.test.mts`; visual checks remain explicitly pending until run in a deployed browser.

## Automated Checks Completed

- [x] Search and settings remain in navigation for every role; all existing admin routes remain available to admins.
- [x] The drawer opens with native `dialog.showModal()`, which applies browser-managed background inertness and focus containment.
- [x] Escape cancellation closes the drawer and restores focus to its trigger.
- [x] Same-route activation keeps focus on the trigger instead of unmounting the focused drawer link.
- [x] Successful navigation transfers focus to the destination `main` landmark after its pathname is active.
- [x] Active-route matching does not incorrectly match similarly prefixed paths.
- [x] No image, icon, font, or texture assets were added. Texture and symbols are original CSS/HTML primitives.

## Manual Browser Checks Pending

- [ ] At 1596px and wider, the shell is centered, desktop navigation is 238px wide, and normal content remains readable.
- [ ] At 991px and narrower, the native modal drawer opens above an inert page; Tab and Shift+Tab stay inside it in Chromium, Firefox, and Safari.
- [ ] At 375px and 200% zoom, applicable search, settings, and admin routes remain reachable without page-level clipping.
- [ ] Drawer trigger, close control, links, and language options expose translated names and visible focus indicators.
- [ ] Users and processing-jobs tables scroll by keyboard on screen without clipping columns or actions.
- [ ] Print preview hides shell chrome, forms, buttons, and action columns; wide tables wrap into the printable width while citation text remains visible.
- [ ] Parchment and dark-shell text meet WCAG AA contrast in browser tooling.

## Print Strategy

Print uses black text on white, removes navigation and interactive forms/buttons, preserves citation quotes as static content, hides table action columns, and forces remaining table cells to wrap in a fixed-width printable table.
