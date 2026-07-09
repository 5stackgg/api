-- Cross-division relegation playoffs. After a season finishes and movements are
-- computed, each adjacent-division boundary with RelegationDown (higher) and
-- RelegationUp (lower) teams becomes a small tournament; its final ranking
-- decides who takes the higher-division spots, written back onto each team's
-- league_team_movements row.

-- Materialize the relegation playoff tournaments for a finished season.
CREATE OR REPLACE FUNCTION public.create_league_relegation_playoffs(_league_season_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    season public.league_seasons;
    _organizer_steam_id bigint;
    boundary RECORD;
    m RECORD;
    _options_id uuid;
    _tournament_id uuid;
    _stage_id uuid;
    _tt_id uuid;
    _seed int;
    _down_count int;
    _participant_count int;
BEGIN
    SELECT * INTO season FROM public.league_seasons WHERE id = _league_season_id;

    _organizer_steam_id := COALESCE(
        season.created_by_steam_id,
        (SELECT steam_id FROM public.players WHERE role = 'administrator' ORDER BY steam_id LIMIT 1)
    );

    -- Boundaries: a higher division (tier T) that has RelegationDown teams and a
    -- lower division (tier T+1) that has RelegationUp teams, this season. Both
    -- sides must have produced movements, which already implies they ran.
    FOR boundary IN
        SELECT hi.id AS higher_division_id, lo.id AS lower_division_id
        FROM public.league_divisions hi
        JOIN public.league_divisions lo ON lo.tier = hi.tier + 1
        WHERE EXISTS (
              SELECT 1 FROM public.league_team_movements mv
              WHERE mv.league_season_id = _league_season_id
                AND mv.from_division_id = hi.id AND mv.type = 'RelegationDown')
          AND EXISTS (
              SELECT 1 FROM public.league_team_movements mv
              WHERE mv.league_season_id = _league_season_id
                AND mv.from_division_id = lo.id AND mv.type = 'RelegationUp')
    LOOP
        -- Already created?
        IF EXISTS (
            SELECT 1 FROM public.league_relegation_playoffs
            WHERE league_season_id = _league_season_id
              AND higher_division_id = boundary.higher_division_id
              AND lower_division_id = boundary.lower_division_id
        ) THEN
            CONTINUE;
        END IF;

        SELECT COUNT(*) INTO _down_count
        FROM public.league_team_movements mv
        WHERE mv.league_season_id = _league_season_id
          AND mv.from_division_id = boundary.higher_division_id
          AND mv.type = 'RelegationDown';

        _options_id := public.clone_match_options(season.match_options_id);
        UPDATE public.match_options SET match_mode = 'admin', best_of = season.playoff_best_of
        WHERE id = _options_id;

        INSERT INTO public.tournaments (name, description, start, organizer_steam_id, status, match_options_id, auto_start, scheduling_mode)
        VALUES (
            season.name || ' — Relegation Playoff',
            'Relegation playoff between adjacent divisions',
            COALESCE(season.starts_at, NOW()),
            _organizer_steam_id,
            'Setup',
            _options_id,
            false,
            'negotiated'
        )
        RETURNING id INTO _tournament_id;

        _seed := 0;
        _participant_count := 0;
        -- Higher-division RelegationDown teams seed above the lower-division
        -- RelegationUp teams; within each group by finishing rank.
        FOR m IN
            SELECT mv.league_team_id, t.id AS team_id, t.name, t.owner_steam_id, t.captain_steam_id,
                   mv.final_rank,
                   CASE WHEN mv.type = 'RelegationDown' THEN 0 ELSE 1 END AS grp
            FROM public.league_team_movements mv
            JOIN public.league_teams lt ON lt.id = mv.league_team_id
            JOIN public.teams t ON t.id = lt.team_id
            WHERE mv.league_season_id = _league_season_id
              AND (
                  (mv.from_division_id = boundary.higher_division_id AND mv.type = 'RelegationDown')
                  OR (mv.from_division_id = boundary.lower_division_id AND mv.type = 'RelegationUp')
              )
            ORDER BY grp ASC, mv.final_rank ASC NULLS LAST
        LOOP
            _seed := _seed + 1;
            _participant_count := _participant_count + 1;
            INSERT INTO public.tournament_teams (tournament_id, team_id, name, owner_steam_id, captain_steam_id, eligible_at, seed)
            VALUES (_tournament_id, m.team_id, m.name, m.owner_steam_id,
                    COALESCE(m.captain_steam_id, m.owner_steam_id), NOW(), _seed)
            RETURNING id INTO _tt_id;

            -- Copy the team's season roster into the playoff tournament roster.
            INSERT INTO public.tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
            SELECT _tt_id, ltr.player_steam_id, _tournament_id, 'Member'
            FROM public.league_team_seasons lts
            JOIN public.league_team_rosters ltr ON ltr.league_team_season_id = lts.id
            WHERE lts.league_season_id = _league_season_id
              AND lts.league_team_id = m.league_team_id
              AND ltr.removed_at IS NULL
            ON CONFLICT DO NOTHING;
        END LOOP;

        -- A round robin ranks the whole set cleanly (top _down_count keep/take
        -- the higher division). The first-stage validator requires >= 4 teams,
        -- which the standard rd=2 + ru=2 boundary satisfies.
        IF _participant_count >= 4 THEN
            INSERT INTO public.tournament_stages (tournament_id, type, "order", min_teams, max_teams, groups, default_best_of)
            VALUES (_tournament_id, 'RoundRobin', 1, 4, _participant_count, 1, season.playoff_best_of)
            RETURNING id INTO _stage_id;

            INSERT INTO public.league_relegation_playoffs (league_season_id, higher_division_id, lower_division_id, tournament_id, higher_slots)
            VALUES (_league_season_id, boundary.higher_division_id, boundary.lower_division_id, _tournament_id, _down_count);

            UPDATE public.tournaments SET status = 'Live' WHERE id = _tournament_id;

            -- Default scheduling windows (one round ~a week apart) so the playoff
            -- still progresses if the captains never negotiate a time.
            INSERT INTO public.tournament_stage_windows (tournament_stage_id, round, opens_at, closes_at, default_match_at)
            SELECT _stage_id, r, NOW(), NOW() + (r * INTERVAL '7 days') + INTERVAL '2 days', NOW() + (r * INTERVAL '7 days')
            FROM generate_series(1, _participant_count) AS r
            ON CONFLICT (tournament_stage_id, round) DO NOTHING;
        ELSE
            -- Too few teams to contest a playoff: nobody moves at this boundary.
            -- Match exactly the participants (higher-div RelegationDown + lower-div
            -- RelegationUp) so a division's other-boundary bands aren't touched.
            UPDATE public.league_team_movements mv
            SET final_to_division_id = mv.from_division_id,
                type = 'Stay',
                approved_at = COALESCE(mv.approved_at, NOW())
            WHERE mv.league_season_id = _league_season_id
              AND (
                  (mv.from_division_id = boundary.higher_division_id AND mv.type = 'RelegationDown')
                  OR (mv.from_division_id = boundary.lower_division_id AND mv.type = 'RelegationUp')
              );
            DELETE FROM public.tournaments WHERE id = _tournament_id;
        END IF;
    END LOOP;
END;
$$;

-- Resolve a finished relegation playoff: top `higher_slots` teams take the
-- higher division, the rest the lower division; write final_to_division_id +
-- final type onto each team's movement.
CREATE OR REPLACE FUNCTION public.resolve_league_relegation_playoff(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    playoff public.league_relegation_playoffs;
    r RECORD;
    _pos int;
BEGIN
    SELECT * INTO playoff FROM public.league_relegation_playoffs WHERE tournament_id = _tournament_id;
    IF playoff IS NULL OR playoff.resolved_at IS NOT NULL THEN
        RETURN;
    END IF;

    _pos := 0;
    FOR r IN
        SELECT tt.team_id, vtsr.rank
        FROM public.v_team_stage_results vtsr
        JOIN public.tournament_stages ts ON ts.id = vtsr.tournament_stage_id
        JOIN public.tournament_teams tt ON tt.id = vtsr.tournament_team_id
        WHERE ts.tournament_id = _tournament_id
        ORDER BY vtsr.rank ASC
    LOOP
        _pos := _pos + 1;

        UPDATE public.league_team_movements mv
        SET final_to_division_id = CASE WHEN _pos <= playoff.higher_slots
                                        THEN playoff.higher_division_id
                                        ELSE playoff.lower_division_id END,
            type = CASE
                WHEN (SELECT tier FROM public.league_divisions WHERE id =
                        CASE WHEN _pos <= playoff.higher_slots THEN playoff.higher_division_id ELSE playoff.lower_division_id END)
                     < (SELECT tier FROM public.league_divisions WHERE id = mv.from_division_id) THEN 'Promote'
                WHEN (SELECT tier FROM public.league_divisions WHERE id =
                        CASE WHEN _pos <= playoff.higher_slots THEN playoff.higher_division_id ELSE playoff.lower_division_id END)
                     > (SELECT tier FROM public.league_divisions WHERE id = mv.from_division_id) THEN 'Relegate'
                ELSE 'Stay'
            END,
            -- The playoff result is final; approving it protects the row from a
            -- later compute_league_season_movements re-run (which deletes only
            -- unapproved movements) reverting it to a provisional band.
            approved_at = COALESCE(mv.approved_at, NOW())
        FROM public.league_teams lt
        WHERE mv.league_season_id = playoff.league_season_id
          AND mv.league_team_id = lt.id
          AND lt.team_id = r.team_id
          AND mv.type IN ('RelegationUp', 'RelegationDown', 'Promote', 'Relegate', 'Stay');
    END LOOP;

    UPDATE public.league_relegation_playoffs SET resolved_at = NOW() WHERE id = playoff.id;
END;
$$;

-- Resolve automatically when the playoff tournament finishes.
CREATE OR REPLACE FUNCTION public.tau_league_relegation_playoff() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = 'Finished' AND OLD.status IS DISTINCT FROM 'Finished'
       AND EXISTS (SELECT 1 FROM public.league_relegation_playoffs WHERE tournament_id = NEW.id) THEN
        PERFORM public.resolve_league_relegation_playoff(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_league_relegation_playoff ON public.tournaments;
CREATE TRIGGER tau_league_relegation_playoff
    AFTER UPDATE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_league_relegation_playoff();
