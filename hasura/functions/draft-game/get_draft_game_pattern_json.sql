-- jsonb wrapper: Hasura computed fields reject an int[] return type
CREATE OR REPLACE FUNCTION public.get_draft_game_pattern_json(dg public.draft_games) RETURNS jsonb
    LANGUAGE sql STABLE
AS $$
    SELECT to_jsonb(public.get_draft_game_pattern(dg));
$$;
