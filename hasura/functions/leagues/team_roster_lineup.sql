-- Reusable roster-status balancing that only TRIMS over-full tiers — players
-- who already fit keep their status (a 5-starter team is never touched).
-- Excess starters (beyond 5, lowest by name) drop to Substitute if slots
-- remain, otherwise to Benched; excess substitutes (beyond team_max_subs(),
-- lowest by name) drop to Benched. Never promotes. Starters are always capped
-- at 5; coaches are ranked like anyone. Sets a GUC so the per-row cap trigger
-- stands aside during the sweep.
CREATE OR REPLACE FUNCTION public.rebalance_team_roster(_team_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _subs int;
    _kept_subs int;
    _sub_capacity int;
BEGIN
    _subs := public.team_max_subs();
    PERFORM set_config('fivestack.rebalancing', 'true', true);

    -- Demote substitutes beyond the cap (lowest by name) to the bench.
    WITH ranked AS (
        SELECT tr.player_steam_id,
               ROW_NUMBER() OVER (
                   ORDER BY COALESCE(p.name, ''), tr.player_steam_id
               ) AS rn
        FROM public.team_roster tr
        LEFT JOIN public.players p ON p.steam_id = tr.player_steam_id
        WHERE tr.team_id = _team_id AND tr.status = 'Substitute'
    )
    UPDATE public.team_roster tr
    SET status = 'Benched'
    FROM ranked r
    WHERE tr.team_id = _team_id
      AND tr.player_steam_id = r.player_steam_id
      AND r.rn > _subs;

    -- Substitute slots still open after keeping the valid subs.
    SELECT COUNT(*) INTO _kept_subs
    FROM public.team_roster
    WHERE team_id = _team_id AND status = 'Substitute';
    _sub_capacity := GREATEST(_subs - _kept_subs, 0);

    -- Demote starters beyond 5 (lowest by name): fill any open sub slots, then
    -- bench the rest. Starters within the cap are left untouched.
    WITH ranked AS (
        SELECT tr.player_steam_id,
               ROW_NUMBER() OVER (
                   ORDER BY COALESCE(p.name, ''), tr.player_steam_id
               ) AS rn
        FROM public.team_roster tr
        LEFT JOIN public.players p ON p.steam_id = tr.player_steam_id
        WHERE tr.team_id = _team_id AND tr.status = 'Starter'
    )
    UPDATE public.team_roster tr
    SET status = CASE
            WHEN r.rn <= 5 + _sub_capacity THEN 'Substitute'
            ELSE 'Benched'
        END
    FROM ranked r
    WHERE tr.team_id = _team_id
      AND tr.player_steam_id = r.player_steam_id
      AND r.rn > 5;
END;
$$;

CREATE OR REPLACE FUNCTION public.rebalance_all_team_rosters()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _team_id uuid;
BEGIN
    FOR _team_id IN SELECT DISTINCT team_id FROM public.team_roster LOOP
        PERFORM public.rebalance_team_roster(_team_id);
    END LOOP;
END;
$$;
