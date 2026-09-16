-- Inlined, not is_tournament_match(): functions/tournaments/ is applied after
-- this directory and LANGUAGE sql bodies are validated at create.
CREATE OR REPLACE FUNCTION public.match_max_players_per_lineup(match matches)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT get_match_type_min_players(mo.type) + CASE
        -- A computed field on every match list row: without substitutes there is nothing to look up.
        WHEN COALESCE(mo.number_of_substitutes, 0) = 0 THEN 0
        WHEN EXISTS (
            SELECT 1
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            INNER JOIN tournaments t ON t.id = ts.tournament_id
            WHERE tb.match_id = match.id
              AND (mo.type = 'Duel' OR NOT t.substitutes_enabled)
        ) THEN 0
        ELSE mo.number_of_substitutes
    END
    FROM match_options mo
    WHERE mo.id = match.match_options_id;
$$;

CREATE OR REPLACE FUNCTION public.match_min_players_per_lineup(match matches)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT get_match_type_min_players(mo.type)
    FROM match_options mo
    WHERE mo.id = match.match_options_id;
$$;

-- Duel is checked per tournament: draft games and one-off Duels still take substitutes.
CREATE OR REPLACE FUNCTION public.tournament_max_players_per_lineup(tournament tournaments)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT get_match_type_min_players(mo.type) + CASE
        WHEN mo.type = 'Duel' OR NOT tournament.substitutes_enabled THEN 0
        ELSE COALESCE(mo.number_of_substitutes, 0)
    END
    FROM match_options mo
    WHERE mo.id = tournament.match_options_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_min_players_per_lineup(tournament tournaments)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT get_match_type_min_players(mo.type)
    FROM match_options mo
    WHERE mo.id = tournament.match_options_id;
$$;
