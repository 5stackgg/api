-- The per-lineup minimum for one match, in precedence order:
--   1. what the match actually launched at (set when a draft force-started short-handed)
--   2. the custom game mode's own team size
--   3. the match type's fixed 5 / 2 / 1
-- Everything that gates on "enough players" reads this rather than the type, so
-- a custom mode can size a match without touching the closed e_match_types enum.
--
-- plpgsql, not sql: this file sorts before get_match_type_min_players.sql, and a
-- LANGUAGE sql body is resolved at creation time -- which would fail the very
-- first boot against an empty database.
CREATE OR REPLACE FUNCTION public.get_match_options_min_players(mo public.match_options)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    mode_players integer;
BEGIN
    IF mo.min_players_per_lineup IS NOT NULL THEN
        RETURN mo.min_players_per_lineup;
    END IF;

    IF mo.game_mode_id IS NOT NULL THEN
        SELECT gm.players_per_team INTO mode_players
        FROM public.game_modes gm
        WHERE gm.id = mo.game_mode_id;

        IF mode_players IS NOT NULL THEN
            RETURN mode_players;
        END IF;
    END IF;

    RETURN public.get_match_type_min_players(mo.type);
END;
$$;
