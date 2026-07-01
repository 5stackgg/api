-- Hasura computed fields must return a base scalar (or SETOF table); an int[]
-- is rejected. Expose the pattern as jsonb for the GraphQL layer while the
-- int[] function stays the source of truth for the pick triggers.
CREATE OR REPLACE FUNCTION public.get_draft_game_pattern_json(dg public.draft_games) RETURNS jsonb
    LANGUAGE sql STABLE
AS $$
    SELECT to_jsonb(public.get_draft_game_pattern(dg));
$$;
