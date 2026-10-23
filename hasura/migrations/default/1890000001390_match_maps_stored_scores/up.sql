-- lineup_1_score and lineup_2_score (computed fields on match_maps) looked up
-- the latest round of every map on every poll of a match page, bracket or
-- list. Each map keeps that score, and hasura/triggers/match_map_rounds.sql
-- updates it as rounds are written.
ALTER TABLE public.match_maps
    ADD COLUMN IF NOT EXISTS lineup_1_rounds_won integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lineup_2_rounds_won integer NOT NULL DEFAULT 0;

UPDATE public.match_maps mm
SET lineup_1_rounds_won = latest.lineup_1_score,
    lineup_2_rounds_won = latest.lineup_2_score
FROM (
    SELECT DISTINCT ON (match_map_id)
           match_map_id,
           COALESCE(lineup_1_score, 0) AS lineup_1_score,
           COALESCE(lineup_2_score, 0) AS lineup_2_score
    FROM public.match_map_rounds
    WHERE deleted_at IS NULL
    ORDER BY match_map_id, time DESC
) latest
WHERE mm.id = latest.match_map_id;
