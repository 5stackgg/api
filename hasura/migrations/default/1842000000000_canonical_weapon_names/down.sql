-- The weapon-name backfill is lossy (many old spellings collapse to one
-- canonical name) and cannot be reversed. The canonical_weapon() function is
-- owned by hasura/functions, not this migration, so there is nothing to drop.
SELECT 1;
