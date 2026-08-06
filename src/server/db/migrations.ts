export const MIGRATION_FILENAMES = [
  "0001_initial_schema.sql",
  "0002_telegram_links.sql",
  "0003_publication_fencing_token.sql",
] as const;

export type MigrationFilename = (typeof MIGRATION_FILENAMES)[number];
