import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const filename="0019_class_species_hierarchy.sql";const sql=await readFile(`migrations/${filename}`,"utf8");

test("0019 registers normalized many-to-many hierarchy and exact NFS relations",()=>{
  assert.equal(MIGRATION_FILENAMES[MIGRATION_FILENAMES.indexOf(filename)+1],"0020_active_revision_trigger_fix.sql");
  for(const table of ["compendium_class_parent_links","compendium_species_parent_links","compendium_class_progression_tables","compendium_class_progression_columns","compendium_class_progression_rows","compendium_class_progression_cells","compendium_class_feature_links","compendium_species_traits","compendium_option_cross_links","nfs_index_option_relations"])assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.doesNotMatch(sql,/parent_(?:class|species)_id\s+uuid/);assert.match(sql,/target_revision_id uuid NOT NULL/);assert.match(sql,/source_id = target_source_id/);
  assert.match(sql,/nfs_option_relations_target_fk[\s\S]*repository_id, target_entry_id, target_revision_id, target_source_id, target_file_id/);
  assert.match(sql,/nfs_option_relations_source_fk[\s\S]*repository_id, source_entry_id, source_revision_id, source_id, source_file_id/);
});

test("every mutable 0019 child table rejects insert, update, and delete after publication",()=>{
  assert.match(sql,/compendium_guard_hierarchy_child_immutability/);assert.match(sql,/BEFORE INSERT OR UPDATE OR DELETE/);assert.match(sql,/published hierarchy revision children are immutable/);
  assert.match(sql,/compendium_revision_is_active\(old_revision\) OR compendium_revision_is_active\(new_revision\)/);
  for(const table of ["compendium_class_parent_links","compendium_species_parent_links","compendium_class_progression_tables","compendium_class_progression_columns","compendium_class_progression_rows","compendium_class_progression_cells","compendium_class_feature_links","compendium_species_traits","compendium_option_cross_links"])assert.match(sql,new RegExp(`'${table}'`));
});

test("publication transitions validate absent and incomplete base progression",()=>{
  assert.match(sql,/compendium_revision_hierarchy_publication/);assert.match(sql,/compendium_version_hierarchy_publication/);
  assert.match(sql,/table_count <> 1/);assert.match(sql,/row_count <> 20/);assert.match(sql,/cell_count <> row_count \* column_count/);
  assert.match(sql,/published base class progression must contain exactly one complete levels 1 through 20 table/);
});

test("deferred graph validation rejects stale targets, cycles, wrong kinds, and invalid overrides",()=>{
  assert.match(sql,/WITH RECURSIVE walk/);assert.match(sql,/hierarchy graph cannot contain cycles/);
  assert.match(sql,/pv\.active_revision_id <> pr\.id/);assert.match(sql,/cv\.source_id <> pv\.source_id/);
  assert.match(sql,/class parent must be an active exact-corpus/);assert.match(sql,/species parent must be an active exact-corpus/);
  assert.match(sql,/parent\.class_kind <> 'class'/);assert.match(sql,/parent\.species_kind <> 'species'/);
  assert.match(sql,/trait override must resolve an inherited parent trait/);assert.match(sql,/DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql,/NFS option relations cannot reference retired or stale entry versions/);
});

test("anchors are unique per revision page and reserved deep IDs are rejected",()=>{
  assert.match(sql,/UNIQUE \(class_revision_id, anchor\)/);assert.match(sql,/UNIQUE \(species_revision_id, anchor\)/);
  assert.match(sql,/anchor <> 'progression'/);assert.match(sql,/level-\(\[1-9\]\|1\[0-9\]\|20\)/);assert.match(sql,/section\(\?:-\|\$\)/);
  assert.match(sql,/anchor !~ '\^citation-'/);
});

test("NFS relations enforce direct base parents and identify exact trait overrides",()=>{
  assert.match(sql,/relation_kind IN \('parent','feature','cross_link','trait_override'\)/);
  assert.match(sql,/source_anchor text NOT NULL/);assert.match(sql,/source_kind = 'subclass' AND actual_kind = 'class'/);
  assert.match(sql,/source_kind = 'variant' AND actual_kind = 'species'/);
  assert.match(sql,/target_trait\.value::jsonb\)->>'anchor' = NEW\.anchor/);
});
