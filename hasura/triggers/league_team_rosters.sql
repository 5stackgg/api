-- League roster guards: lock date and roster size cap, mirroring into the
-- per-tournament roster (which is what match lineups are built from) once a
-- season is live. Rosters are SOFT-deleted: `removed_at IS NULL` = active,
-- so history (who was added/removed mid-season and why) is preserved.

-- Lineup caps: a team season holds at most `min_roster_size` starters and
-- `team_max_subs` substitutes (a "Benched" status, if ever used, is
-- unrestricted). Excludes the row's own player so it is safe on both INSERT
-- (player not yet present) and status-change UPDATE (excludes the moving row).
CREATE OR REPLACE FUNCTION public.assert_league_lineup_capacity(
    _team_season_id uuid, _player_steam_id bigint, _status text
) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _cap int;
    _count int;
BEGIN
    IF _status = 'Starter' THEN
        SELECT COALESCE(ls.min_roster_size, public.team_min_roster_size())
          INTO _cap
        FROM public.league_seasons ls
        JOIN public.league_team_seasons lts ON lts.league_season_id = ls.id
        WHERE lts.id = _team_season_id;

        SELECT COUNT(*) INTO _count
        FROM public.league_team_rosters
        WHERE league_team_season_id = _team_season_id
          AND removed_at IS NULL
          AND status = 'Starter'
          AND player_steam_id != _player_steam_id;

        IF _cap IS NOT NULL AND _count >= _cap THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'The starting lineup is full (' || _cap || ' starters max)';
        END IF;

    ELSIF _status = 'Substitute' THEN
        _cap := public.team_max_subs();

        SELECT COUNT(*) INTO _count
        FROM public.league_team_rosters
        WHERE league_team_season_id = _team_season_id
          AND removed_at IS NULL
          AND status = 'Substitute'
          AND player_steam_id != _player_steam_id;

        IF _cap IS NOT NULL AND _count >= _cap THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'The bench is full (' || _cap || ' substitutes max)';
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbi_league_team_rosters() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    season public.league_seasons;
    _role text;
    _roster_count int;
    _max_roster int;
BEGIN
    SELECT ls.* INTO season
    FROM public.league_seasons ls
    JOIN public.league_team_seasons lts ON lts.league_season_id = ls.id
    WHERE lts.id = NEW.league_team_season_id;

    _role := current_setting('hasura.user', true)::json ->> 'x-hasura-role';

    -- Admins (platform or league) may adjust rosters past the lock
    -- (dispute resolution).
    IF _role IS NOT NULL AND NOT public.is_league_admin_for_session(
        current_setting('hasura.user', true)::json
    ) THEN
        IF public.league_season_is_roster_locked(season) THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The roster is locked for this season';
        END IF;
    END IF;

    IF season.status IN ('Finished', 'Canceled') THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The season is over';
    END IF;

    _max_roster := COALESCE(season.max_roster_size, public.team_max_roster_size());
    IF _max_roster IS NOT NULL THEN
        -- Exclude the row's own player: INSERT ... ON CONFLICT still fires this
        -- BEFORE INSERT trigger for rows that resolve to an update, so an upsert
        -- of an already-active player must not count itself (mirrors the revive
        -- branch and assert_league_lineup_capacity).
        SELECT COUNT(*) INTO _roster_count
        FROM public.league_team_rosters
        WHERE league_team_season_id = NEW.league_team_season_id
          AND removed_at IS NULL
          AND player_steam_id != NEW.player_steam_id;
        IF _roster_count >= _max_roster THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'The roster is full (' || _max_roster || ' players max)';
        END IF;
    END IF;

    -- Starter / substitute lineup caps.
    PERFORM public.assert_league_lineup_capacity(
        NEW.league_team_season_id, NEW.player_steam_id, NEW.status
    );

    -- One team per player per season: dual-rostering is never allowed
    -- (classic CAL rule). No admin bypass — remove the other entry first.
    IF EXISTS (
        SELECT 1
        FROM public.league_team_rosters ltr
        JOIN public.league_team_seasons other ON other.id = ltr.league_team_season_id
        JOIN public.league_team_seasons mine ON mine.id = NEW.league_team_season_id
        WHERE ltr.player_steam_id = NEW.player_steam_id
          AND ltr.removed_at IS NULL
          AND other.league_season_id = mine.league_season_id
          AND other.id != mine.id
          AND other.status != 'Withdrawn'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This player is already rostered on another team this season';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_league_team_rosters ON public.league_team_rosters;
CREATE TRIGGER tbi_league_team_rosters
    BEFORE INSERT ON public.league_team_rosters
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_league_team_rosters();

-- Soft-remove (removed_at set) and revive (removed_at cleared) guards. There is
-- no minimum-roster floor here: dropping below the minimum is allowed, and the
-- team is warned then revoked at league start instead. A DB-driven cascade
-- (e.g. leaving the underlying team) sets fivestack.league_cascade to stand
-- aside from the lock check.
CREATE OR REPLACE FUNCTION public.tbu_league_team_rosters() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    season public.league_seasons;
    _role text;
    _is_admin boolean;
    _roster_count int;
    _max_roster int;
BEGIN
    -- A status change (promote/demote) enforces the lineup caps even though it
    -- leaves removed_at untouched, which short-circuits the guards below.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.removed_at IS NULL THEN
        PERFORM public.assert_league_lineup_capacity(
            NEW.league_team_season_id, NEW.player_steam_id, NEW.status
        );
    END IF;

    IF NEW.removed_at IS NOT DISTINCT FROM OLD.removed_at THEN
        RETURN NEW;
    END IF;

    IF current_setting('fivestack.league_cascade', true) = 'true' THEN
        RETURN NEW;
    END IF;

    SELECT ls.* INTO season
    FROM public.league_seasons ls
    JOIN public.league_team_seasons lts ON lts.league_season_id = ls.id
    WHERE lts.id = NEW.league_team_season_id;

    _role := current_setting('hasura.user', true)::json ->> 'x-hasura-role';
    _is_admin := _role IS NULL OR public.is_league_admin_for_session(
        current_setting('hasura.user', true)::json
    );

    IF NOT _is_admin AND public.league_season_is_roster_locked(season) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The roster is locked for this season';
    END IF;

    -- Reviving a previously removed player re-applies the size + dual-roster caps.
    IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN
        _max_roster := COALESCE(season.max_roster_size, public.team_max_roster_size());
        IF _max_roster IS NOT NULL THEN
            SELECT COUNT(*) INTO _roster_count
            FROM public.league_team_rosters
            WHERE league_team_season_id = NEW.league_team_season_id
              AND removed_at IS NULL
              AND player_steam_id != NEW.player_steam_id;
            IF _roster_count >= _max_roster THEN
                RAISE EXCEPTION USING ERRCODE = '22000',
                    MESSAGE = 'The roster is full (' || _max_roster || ' players max)';
            END IF;
        END IF;

        -- Reviving also re-applies the starter / substitute lineup caps.
        PERFORM public.assert_league_lineup_capacity(
            NEW.league_team_season_id, NEW.player_steam_id, NEW.status
        );

        IF EXISTS (
            SELECT 1
            FROM public.league_team_rosters ltr
            JOIN public.league_team_seasons other ON other.id = ltr.league_team_season_id
            JOIN public.league_team_seasons mine ON mine.id = NEW.league_team_season_id
            WHERE ltr.player_steam_id = NEW.player_steam_id
              AND ltr.removed_at IS NULL
              AND other.league_season_id = mine.league_season_id
              AND other.id != mine.id
              AND other.status != 'Withdrawn'
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'This player is already rostered on another team this season';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_league_team_rosters ON public.league_team_rosters;
CREATE TRIGGER tbu_league_team_rosters
    BEFORE UPDATE ON public.league_team_rosters
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_league_team_rosters();

-- Mirror roster changes into tournament_team_roster while the season runs so
-- active players are eligible for lineups without manual sync. Fires on insert
-- and on the removed_at transition (revive mirrors in, soft-remove mirrors out).
CREATE OR REPLACE FUNCTION public.taiu_league_team_rosters() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament_team_id uuid;
    _tournament_id uuid;
    _activated boolean;
    _deactivated boolean;
BEGIN
    IF TG_OP = 'INSERT' THEN
        _activated := NEW.removed_at IS NULL;
        _deactivated := false;
    ELSE
        _activated := OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL;
        _deactivated := OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL;
    END IF;

    IF NOT _activated AND NOT _deactivated THEN
        RETURN NEW;
    END IF;

    SELECT lts.tournament_team_id, tt.tournament_id
    INTO _tournament_team_id, _tournament_id
    FROM public.league_team_seasons lts
    JOIN public.tournament_teams tt ON tt.id = lts.tournament_team_id
    WHERE lts.id = NEW.league_team_season_id;

    IF _tournament_team_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF _activated THEN
        INSERT INTO public.tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
        VALUES (_tournament_team_id, NEW.player_steam_id, _tournament_id, 'Member')
        ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM public.tournament_team_roster
        WHERE tournament_team_id = _tournament_team_id
          AND player_steam_id = NEW.player_steam_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_league_team_rosters ON public.league_team_rosters;
DROP TRIGGER IF EXISTS taiu_league_team_rosters ON public.league_team_rosters;
CREATE TRIGGER taiu_league_team_rosters
    AFTER INSERT OR UPDATE ON public.league_team_rosters
    FOR EACH ROW
    EXECUTE FUNCTION public.taiu_league_team_rosters();

-- Hard deletes (admin cleanup / cascade) still mirror the removal out of the
-- tournament roster.
CREATE OR REPLACE FUNCTION public.tad_league_team_rosters() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament_team_id uuid;
BEGIN
    SELECT lts.tournament_team_id
    INTO _tournament_team_id
    FROM public.league_team_seasons lts
    WHERE lts.id = OLD.league_team_season_id;

    IF _tournament_team_id IS NOT NULL THEN
        DELETE FROM public.tournament_team_roster
        WHERE tournament_team_id = _tournament_team_id
          AND player_steam_id = OLD.player_steam_id;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_league_team_rosters ON public.league_team_rosters;
DROP TRIGGER IF EXISTS tad_league_team_rosters ON public.league_team_rosters;
CREATE TRIGGER tad_league_team_rosters
    AFTER DELETE ON public.league_team_rosters
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_league_team_rosters();
