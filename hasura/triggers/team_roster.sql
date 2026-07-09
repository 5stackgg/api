CREATE OR REPLACE FUNCTION public.tbi_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _owner_steam_id bigint;
BEGIN
    NEW.role = 'Member';

    SELECT owner_steam_id INTO _owner_steam_id FROM teams WHERE id = NEW.team_id;

    IF _owner_steam_id = NEW.player_steam_id THEN 
        NEW.role = 'Admin';
        RETURN NEW;
    END IF;

   IF current_setting('hasura.user')::jsonb ->> 'x-hasura-role' IN ('admin', 'administrator') THEN
        RETURN NEW;
    END IF;

    INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
        VALUES (NEW.team_id, NEW.player_steam_id, (current_setting('hasura.user')::jsonb->>'x-hasura-user-id')::bigint);

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tbi_team_roster ON public.team_roster;
CREATE TRIGGER tbi_team_roster BEFORE INSERT ON public.team_roster FOR EACH ROW EXECUTE FUNCTION public.tbi_team_roster();

CREATE OR REPLACE FUNCTION public.tad_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _owner_steam_id bigint;
BEGIN
    -- Leaving the team drops the player from any ACTIVE league roster (season
    -- not yet finished/canceled), preserving history via soft-delete. The GUC
    -- lets the league roster trigger stand aside from the lock check.
    PERFORM set_config('fivestack.league_cascade', 'true', true);
    UPDATE public.league_team_rosters ltr
    SET removed_at = NOW(),
        removed_reason = 'Left team'
    FROM public.league_team_seasons lts
    JOIN public.league_teams lt ON lt.id = lts.league_team_id
    JOIN public.league_seasons ls ON ls.id = lts.league_season_id
    WHERE ltr.league_team_season_id = lts.id
      AND ltr.player_steam_id = OLD.player_steam_id
      AND ltr.removed_at IS NULL
      AND lt.team_id = OLD.team_id
      AND ls.status NOT IN ('Finished', 'Canceled');
    PERFORM set_config('fivestack.league_cascade', 'false', true);

    IF EXISTS (
        SELECT 1
        FROM teams t
        WHERE t.id = OLD.team_id
          AND t.captain_steam_id = OLD.player_steam_id
    ) THEN
        SELECT owner_steam_id
        INTO _owner_steam_id
        FROM teams
        WHERE id = OLD.team_id;

        IF _owner_steam_id IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM team_roster tr
                WHERE tr.team_id = OLD.team_id
                  AND tr.player_steam_id = _owner_steam_id
            ) THEN
            UPDATE teams
            SET captain_steam_id = _owner_steam_id
            WHERE id = OLD.team_id;
        ELSE
            UPDATE teams
            SET captain_steam_id = NULL
            WHERE id = OLD.team_id;
        END IF;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_team_roster ON public.team_roster;
CREATE TRIGGER tad_team_roster AFTER DELETE ON public.team_roster FOR EACH ROW EXECUTE FUNCTION public.tad_team_roster();
-- Roster status caps: always 5 starters and team_max_subs() substitutes per
-- team. On insert a would-be starter cascades down to the next open slot
-- (Starter -> Substitute -> Benched) so adding a player never fails; an
-- explicit promotion once a tier is full is rejected. Coaches are ranked like
-- anyone. The bulk rebalance sets fivestack.rebalancing so this stands aside.
CREATE OR REPLACE FUNCTION public.tbiu_team_roster_status() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _count int;
    _max int;
BEGIN
    IF current_setting('fivestack.rebalancing', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'Starter' THEN
        _max := 5;
        SELECT COUNT(*) INTO _count FROM public.team_roster
        WHERE team_id = NEW.team_id AND status = 'Starter'
          AND player_steam_id <> NEW.player_steam_id;
        IF _count >= _max THEN
            IF TG_OP = 'INSERT' THEN
                NEW.status := 'Substitute';
            ELSE
                RAISE EXCEPTION USING ERRCODE = '22000',
                    MESSAGE = 'Only ' || _max || ' starters are allowed; bench a starter first';
            END IF;
        END IF;
    END IF;

    IF NEW.status = 'Substitute' THEN
        _max := public.team_max_subs();
        SELECT COUNT(*) INTO _count FROM public.team_roster
        WHERE team_id = NEW.team_id AND status = 'Substitute'
          AND player_steam_id <> NEW.player_steam_id;
        IF _count >= _max THEN
            IF TG_OP = 'INSERT' THEN
                NEW.status := 'Benched';
            ELSE
                RAISE EXCEPTION USING ERRCODE = '22000',
                    MESSAGE = 'Only ' || _max || ' substitutes are allowed';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_team_roster_status ON public.team_roster;
CREATE TRIGGER tbiu_team_roster_status
    BEFORE INSERT OR UPDATE ON public.team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.tbiu_team_roster_status();
