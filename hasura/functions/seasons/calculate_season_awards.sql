-- Season placements, mirroring calculate_tournament_awards: the ladder decides
-- gold/silver/bronze and a performance metric decides MVP, so the two are not
-- always the same player.
CREATE OR REPLACE FUNCTION public.calculate_season_awards(_season_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _mvp_steam_id bigint;
BEGIN
    -- Always clear prior calculated rows so a recalculation lands in a known
    -- state. Hand-granted season awards are the organizer's and survive.
    DELETE FROM public.award_recipients
    WHERE season_id = _season_id AND source = 'season';

    IF NOT EXISTS (SELECT 1 FROM public.seasons WHERE id = _season_id) THEN
        RETURN;
    END IF;

    -- Ranking reuses the ELO leaderboard rather than re-deriving it, so the
    -- award always agrees with what the leaderboard shows for the season.
    INSERT INTO public.award_recipients
        (award_id, season_id, player_steam_id, placement, source)
    SELECT
        (SELECT a.id FROM public.awards a
          WHERE a.system_key = CASE ranked.rank
                WHEN 1 THEN 'season_gold'
                WHEN 2 THEN 'season_silver'
                ELSE 'season_bronze'
          END),
        _season_id,
        ranked.player_steam_id::bigint,
        ranked.rank,
        'season'
    FROM (
        SELECT
            entry.player_steam_id,
            -- steam_id breaks ties so a recalculation cannot swap two players
            -- on equal elo between 2nd and 3rd.
            ROW_NUMBER() OVER (
                ORDER BY entry.value DESC, entry.player_steam_id ASC
            ) AS rank
        FROM public._leaderboard_elo(0, NULL, false, _season_id) entry
    ) ranked
    WHERE ranked.rank <= 3
    ON CONFLICT DO NOTHING;

    -- MVP: highest average in-match impact over the season, the same metric a
    -- tournament MVP uses.
    SELECT pe.steam_id
      INTO _mvp_steam_id
    FROM public.player_elo pe
    WHERE pe.season_id = _season_id
    GROUP BY pe.steam_id
    HAVING COUNT(*) > 0
    ORDER BY AVG(COALESCE(pe.impact, 1.0)) DESC,
             SUM(COALESCE(pe.impact, 1.0)) DESC,
             pe.steam_id ASC
    LIMIT 1;

    IF _mvp_steam_id IS NOT NULL THEN
        INSERT INTO public.award_recipients
            (award_id, season_id, player_steam_id, placement, source)
        VALUES
            ((SELECT a.id FROM public.awards a WHERE a.system_key = 'season_mvp'),
             _season_id, _mvp_steam_id, 0, 'season')
        ON CONFLICT DO NOTHING;
    END IF;
END;
$$;
