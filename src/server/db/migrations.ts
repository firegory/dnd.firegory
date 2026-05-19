export const MIGRATION_FILENAMES = ["0001_initial_schema.sql"] as const;

export type MigrationFilename = (typeof MIGRATION_FILENAMES)[number];
