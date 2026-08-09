const IMPORT_RUN_STATUS_STYLES: Readonly<Record<string, string>> = {
  succeeded: "bg-status-success/15 text-status-success",
  completed: "bg-status-success/15 text-status-success",
  failed: "bg-danger/15 text-danger",
  running: "bg-warning/15 text-warning",
  pending: "bg-surface-light text-text-muted",
  cancelled: "bg-surface-light text-text-muted",
};

export function importRunStatusClass(status: string): string {
  return IMPORT_RUN_STATUS_STYLES[status] ?? "bg-surface-light text-text-muted";
}
