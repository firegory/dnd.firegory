-- Guide article candidates participate in the resumable import/review workflow,
-- but remain outside canonical publication until converted to controlled blocks.
ALTER TYPE compendium_entry_type ADD VALUE IF NOT EXISTS 'guide';
