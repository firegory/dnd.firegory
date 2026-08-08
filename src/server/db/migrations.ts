export const MIGRATION_FILENAMES = [
  "0001_initial_schema.sql",
  "0002_telegram_links.sql",
  "0003_source_publication_metadata.sql",
  "0004_source_publication_constraints.sql",
  "0005_ingestion_generations.sql",
  "0006_ingestion_generation_integrity.sql",
  "0007_compendium_relational_core.sql",
  "0008_resumable_compendium_imports.sql",
  // 0009 remains intentionally unused after issue #81.
  "0010_nfs_content_index_sync.sql",
  "0011_compendium_candidate_identity.sql",
  // 0012 remains reserved by parallel compendium work.
  "0013_compendium_import_review.sql",
  "0014_compendium_entry_editor.sql",
  "0015_spells_vertical_slice.sql",
  "0016_compendium_guide_candidate_type.sql",
  "0017_flat_compendium_types.sql",
  "0018_bestiary_stat_blocks.sql",
  "0019_class_species_hierarchy.sql",
  "0020_active_revision_trigger_fix.sql",
  "0021_nfs_exact_lookup_indexes.sql",
  "0022_import_review_canonical_revision.sql",
] as const;

export type MigrationFilename = (typeof MIGRATION_FILENAMES)[number];
