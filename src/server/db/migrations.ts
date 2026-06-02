export const MIGRATION_FILENAMES = ["0001_initial_schema.sql", "0002_entities.sql", "0003_add_class_type.sql"] as const;

export type MigrationFilename = (typeof MIGRATION_FILENAMES)[number];
