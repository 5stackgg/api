-- Neither column was ever read, and neither could be set: the mode form has no
-- field for them. A mode can only ever pre-fill match options anyway, because
-- tbu_match_options locks them once a match is Live -- so overriding at runtime
-- would make the match record disagree with what was played.
--
-- match_option_defaults was untyped jsonb shadowing 26 real columns on
-- match_options, where a mistyped key fails silently. If defaults are wanted
-- later they belong as typed nullable columns here.
ALTER TABLE "public"."game_modes"
    DROP COLUMN IF EXISTS "match_option_defaults";

ALTER TABLE "public"."game_modes"
    DROP COLUMN IF EXISTS "map_pool_id";
