export const PENDING_MAIN_FOCUS_KEY = "dnd.firegory.pendingMainFocus";

type ModalDialog = {
  open: boolean;
  showModal: () => void;
  close: () => void;
};

type FocusTarget = {
  focus: (options?: FocusOptions) => void;
};

type FocusStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function openModalDrawer(dialog: ModalDialog, initialFocus?: FocusTarget | null): void {
  if (!dialog.open) dialog.showModal();
  initialFocus?.focus();
}

export function closeModalDrawer(
  dialog: ModalDialog | null,
  trigger: FocusTarget | null,
  restoreFocus: boolean,
): void {
  if (dialog?.open) dialog.close();
  if (restoreFocus) trigger?.focus();
}

export function handleModalCancel(event: Pick<Event, "preventDefault">, close: () => void): void {
  event.preventDefault();
  close();
}

export function beginDrawerNavigation(currentPath: string, targetPath: string, store: FocusStore): boolean {
  if (currentPath === targetPath) return true;
  store.setItem(PENDING_MAIN_FOCUS_KEY, targetPath);
  return false;
}

export function focusMainAfterNavigation(
  pathname: string,
  store: FocusStore,
  main: FocusTarget | null,
): boolean {
  const targetPath = store.getItem(PENDING_MAIN_FOCUS_KEY);
  if (!targetPath) return false;
  if (targetPath !== pathname) {
    store.removeItem(PENDING_MAIN_FOCUS_KEY);
    return false;
  }
  if (!main) return false;
  store.removeItem(PENDING_MAIN_FOCUS_KEY);
  main.focus({ preventScroll: true });
  return true;
}
