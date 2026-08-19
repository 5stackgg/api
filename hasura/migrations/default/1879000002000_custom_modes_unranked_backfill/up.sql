-- Every custom mode is now unranked, whatever competitive_safe says. The flag
-- is stamped on the match at insert (tbi_matches_ranking), so matches created
-- under the previous rule -- a competitive_safe mode counted -- are re-stamped
-- here. Spelled out rather than calling match_ranking_for_options: that
-- function lives in hasura/triggers and is applied after migrations, so a
-- fresh database would not have it yet.
UPDATE "public"."matches" m
   SET counts_toward_ranking = false
  FROM "public"."match_options" mo
 WHERE mo.id = m.match_options_id
   AND mo.game_mode_id IS NOT NULL
   AND m.counts_toward_ranking = true;
