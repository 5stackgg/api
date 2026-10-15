-- Who can be the MVP, best first: the winning team's rostered players with a
-- rating in any of the tournament's matches, by average in-match impact, then
-- total. Rank 1 is the automatic pick, and an organizer picks from no one else.
-- Impact is a level 0.8-1.2 metric (KDA-vs-team + damage share), so the MVP
-- reflects match performance rather than ELO swings, which favor low-rated
-- upsetters.
-- plpgsql, not sql: a sql body is parsed at CREATE time, and
-- tournament_placements is created after this file.
CREATE OR REPLACE FUNCTION public.tournament_mvp_candidates(_tournament_id uuid)
RETURNS TABLE (
    player_steam_id bigint,
    tournament_team_id uuid,
    avg_impact double precision,
    total_impact double precision,
    matches integer,
    rank integer
)
LANGUAGE plpgsql STABLE
AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    WITH winner AS (
        SELECT p.tournament_team_id
        FROM public.tournament_placements(_tournament_id) p
        WHERE p.placement = 1
        LIMIT 1
    ),
    t_matches AS (
        SELECT DISTINCT tb.match_id
        FROM public.tournament_brackets tb
        JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
          AND tb.match_id IS NOT NULL
    ),
    player_impact AS (
        SELECT
            pe.steam_id,
            AVG(COALESCE(pe.impact, 1.0))::float AS avg_impact,
            SUM(COALESCE(pe.impact, 1.0))::float AS total_impact,
            COUNT(*)::int AS matches
        FROM public.player_elo pe
        WHERE pe.match_id IN (SELECT t_matches.match_id FROM t_matches)
        GROUP BY pe.steam_id
    )
    SELECT
        pi.steam_id,
        winner.tournament_team_id,
        pi.avg_impact,
        pi.total_impact,
        pi.matches,
        (ROW_NUMBER() OVER (
            ORDER BY pi.avg_impact DESC, pi.total_impact DESC, pi.steam_id ASC
        ))::int
    FROM player_impact pi
    JOIN winner ON true
    JOIN public.tournament_team_roster roster
      ON roster.player_steam_id = pi.steam_id
     AND roster.tournament_id = _tournament_id
     AND roster.tournament_team_id = winner.tournament_team_id
    WHERE pi.matches > 0;
END;
$$;

-- The same people Hasura lets manage the tournament (is_organizer): its owner
-- and co-organizers, the global tournament organizer role and administrators.
-- COALESCE so a guest session answers false rather than NULL.
CREATE OR REPLACE FUNCTION public.can_pick_tournament_mvp(
    tournament public.tournaments,
    hasura_session json
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(public.is_tournament_organizer(tournament, hasura_session), false);
$$;

-- Puts the MVP in force: the latest organizer pick while its player is still a
-- candidate, otherwise the automatic pick unless the organizers pick it
-- themselves. A kept automatic pick (keep_tournament_mvp) holds only while they
-- do, and stays the automatic pick on the award row. A hand-granted
-- placement 0 row predates picks and is left alone. Returns the new grant, or
-- NULL when nothing changed.
CREATE OR REPLACE FUNCTION public.apply_tournament_mvp(_tournament_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _pick public.tournament_mvp_picks;
    _current public.award_recipients;
    _award_id uuid;
    _steam_id bigint;
    _tournament_team_id uuid;
    _picked_by bigint;
    _note text;
    _recipient_id uuid;
BEGIN
    SELECT * INTO _tournament FROM public.tournaments WHERE id = _tournament_id;

    IF _tournament.awards_enabled IS DISTINCT FROM true THEN
        RETURN NULL;
    END IF;

    SELECT * INTO _pick
    FROM public.tournament_mvp_picks p
    WHERE p.tournament_id = _tournament_id
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 1;

    IF _pick.id IS NOT NULL
       AND (_tournament.organizer_picks_mvp OR NOT _pick.kept_automatic) THEN
        SELECT c.player_steam_id, c.tournament_team_id
          INTO _steam_id, _tournament_team_id
        FROM public.tournament_mvp_candidates(_tournament_id) c
        WHERE c.player_steam_id = _pick.player_steam_id;

        IF _steam_id IS NOT NULL AND NOT _pick.kept_automatic THEN
            _picked_by := _pick.picked_by_steam_id;
            _note := _pick.note;
        END IF;
    END IF;

    IF _steam_id IS NULL AND NOT _tournament.organizer_picks_mvp THEN
        SELECT c.player_steam_id, c.tournament_team_id
          INTO _steam_id, _tournament_team_id
        FROM public.tournament_mvp_candidates(_tournament_id) c
        WHERE c.rank = 1;
    END IF;

    SELECT * INTO _current
    FROM public.award_recipients r
    WHERE r.tournament_id = _tournament_id
      AND r.placement = 0;

    IF _current.id IS NOT NULL AND _current.source IS DISTINCT FROM 'tournament' THEN
        RETURN NULL;
    END IF;

    _award_id := public.resolve_tournament_award(_tournament_id, 0);

    IF _current.id IS NOT NULL
       AND _current.player_steam_id IS NOT DISTINCT FROM _steam_id
       AND _current.awarded_by_steam_id IS NOT DISTINCT FROM _picked_by
       AND _current.note IS NOT DISTINCT FROM _note
       AND _current.award_id IS NOT DISTINCT FROM _award_id THEN
        RETURN NULL;
    END IF;

    DELETE FROM public.award_recipients
    WHERE tournament_id = _tournament_id
      AND placement = 0
      AND source = 'tournament';

    IF _steam_id IS NULL THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.award_recipients
        (award_id, tournament_id, tournament_team_id, player_steam_id,
         placement, source, awarded_by_steam_id, note)
    VALUES
        (_award_id, _tournament_id, _tournament_team_id, _steam_id,
         0, 'tournament', _picked_by, _note)
    ON CONFLICT DO NOTHING
    RETURNING id INTO _recipient_id;

    RETURN _recipient_id;
END;
$$;

-- Callers check who is picking (AwardsController); this holds the award's
-- rules. Returns the new grant when the MVP changed hands, for its
-- notification, and NULL otherwise.
CREATE OR REPLACE FUNCTION public.set_tournament_mvp(
    _tournament_id uuid,
    _player_steam_id bigint,
    _picked_by_steam_id bigint,
    _note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _candidate record;
    _automatic record;
    _current public.award_recipients;
    _recipient_id uuid;
BEGIN
    SELECT * INTO _tournament
    FROM public.tournaments
    WHERE id = _tournament_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Tournament not found';
    END IF;

    IF _tournament.status IS DISTINCT FROM 'Finished' THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The MVP can only be picked once the tournament has finished';
    END IF;

    IF _tournament.awards_enabled IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Awards are off for this tournament, so it has no MVP';
    END IF;

    _note := NULLIF(btrim(_note), '');

    IF char_length(_note) > 140 THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The note can be at most 140 characters';
    END IF;

    SELECT * INTO _candidate
    FROM public.tournament_mvp_candidates(_tournament_id) c
    WHERE c.player_steam_id = _player_steam_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This player is not one of the winning team''s players who played';
    END IF;

    SELECT * INTO _current
    FROM public.award_recipients r
    WHERE r.tournament_id = _tournament_id
      AND r.placement = 0;

    IF _current.id IS NOT NULL AND _current.source IS DISTINCT FROM 'tournament' THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This tournament''s MVP was granted by hand; remove that award first';
    END IF;

    IF _current.player_steam_id IS NOT DISTINCT FROM _player_steam_id
       AND _current.awarded_by_steam_id IS NOT NULL
       AND _current.note IS NOT DISTINCT FROM _note THEN
        RETURN NULL;
    END IF;

    SELECT * INTO _automatic
    FROM public.tournament_mvp_candidates(_tournament_id) c
    WHERE c.rank = 1;

    INSERT INTO public.tournament_mvp_picks
        (tournament_id, player_steam_id, tournament_team_id, picked_by_steam_id,
         note, player_impact, automatic_steam_id, automatic_impact,
         replaced_steam_id)
    VALUES
        (_tournament_id, _player_steam_id, _candidate.tournament_team_id,
         _picked_by_steam_id, _note, _candidate.avg_impact,
         _automatic.player_steam_id, _automatic.avg_impact,
         _current.player_steam_id);

    _recipient_id := public.apply_tournament_mvp(_tournament_id);

    IF _current.player_steam_id IS NOT DISTINCT FROM _player_steam_id THEN
        RETURN NULL;
    END IF;

    RETURN _recipient_id;
END;
$$;

-- Turning "I'll pick the MVP myself" on after the finish keeps the MVP already
-- given. Recorded as a pick, or the next recalculation would find no pick and
-- the switch on, and take it away.
CREATE OR REPLACE FUNCTION public.keep_tournament_mvp(
    _tournament_id uuid,
    _kept_by_steam_id bigint
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _current public.award_recipients;
    _candidate record;
BEGIN
    SELECT * INTO _current
    FROM public.award_recipients r
    WHERE r.tournament_id = _tournament_id
      AND r.placement = 0;

    IF _current.id IS NULL
       OR _current.source IS DISTINCT FROM 'tournament'
       OR _current.awarded_by_steam_id IS NOT NULL THEN
        RETURN;
    END IF;

    SELECT * INTO _candidate
    FROM public.tournament_mvp_candidates(_tournament_id) c
    WHERE c.player_steam_id = _current.player_steam_id;

    INSERT INTO public.tournament_mvp_picks
        (tournament_id, player_steam_id, tournament_team_id, picked_by_steam_id,
         player_impact, automatic_steam_id, automatic_impact, kept_automatic)
    VALUES
        (_tournament_id, _current.player_steam_id, _current.tournament_team_id,
         (SELECT p.steam_id FROM public.players p WHERE p.steam_id = _kept_by_steam_id),
         _candidate.avg_impact, _current.player_steam_id, _candidate.avg_impact,
         true);
END;
$$;
