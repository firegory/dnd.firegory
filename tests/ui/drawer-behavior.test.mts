import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PENDING_MAIN_FOCUS_KEY,
  beginDrawerNavigation,
  closeModalDrawer,
  focusMainAfterNavigation,
  handleModalCancel,
  openModalDrawer,
} from "../../src/components/ui/drawer-behavior.ts";

function createStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("mobile drawer behavior", () => {
  it("opens through showModal so the browser makes the background inert and traps focus", () => {
    const calls: string[] = [];
    const dialog = {
      open: false,
      showModal() { calls.push("showModal"); this.open = true; },
      close() { calls.push("close"); this.open = false; },
    };
    const firstLink = { focus: () => calls.push("focus-first-link") };

    openModalDrawer(dialog, firstLink);
    assert.deepEqual(calls, ["showModal", "focus-first-link"]);
    assert.equal(dialog.open, true);
  });

  it("handles Escape cancellation and restores focus to the trigger", () => {
    const calls: string[] = [];
    const dialog = { open: true, showModal() {}, close() { calls.push("close"); this.open = false; } };
    const trigger = { focus: () => calls.push("focus-trigger") };

    handleModalCancel({ preventDefault: () => calls.push("prevent-default") }, () => {
      closeModalDrawer(dialog, trigger, true);
    });

    assert.deepEqual(calls, ["prevent-default", "close", "focus-trigger"]);
  });

  it("restores trigger focus for same-route activation without queuing main focus", () => {
    const store = createStore();
    assert.equal(beginDrawerNavigation("/search", "/search", store), true);
    assert.equal(store.getItem(PENDING_MAIN_FOCUS_KEY), null);
  });

  it("moves focus to main only after successful navigation reaches its destination", () => {
    const store = createStore();
    const focusOptions: FocusOptions[] = [];
    const main = { focus: (options?: FocusOptions) => focusOptions.push(options ?? {}) };

    assert.equal(beginDrawerNavigation("/search", "/settings", store), false);
    assert.equal(focusMainAfterNavigation("/settings", store, main), true);
    assert.deepEqual(focusOptions, [{ preventScroll: true }]);
    assert.equal(store.getItem(PENDING_MAIN_FOCUS_KEY), null);
  });

  it("discards focus intent when navigation redirects elsewhere", () => {
    const store = createStore();
    beginDrawerNavigation("/search", "/settings", store);

    assert.equal(focusMainAfterNavigation("/login", store, { focus() {} }), false);
    assert.equal(store.getItem(PENDING_MAIN_FOCUS_KEY), null);
  });
});
