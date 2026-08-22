-- map_name is a plain text column rather than a FK, because maps is
-- UNIQUE (name, type) and a lineup describes geometry, not a match type. This
-- is the check that keeps it honest.
CREATE OR REPLACE FUNCTION public.tbiu_utility_lineups() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();

    -- Stamped here, not left to a Hasura column preset: a role whose insert
    -- permission was written without the preset sends nothing for this column
    -- and lands a NOT NULL violation. See hasura_session_steam_id().
    IF TG_OP = 'INSERT' THEN
        NEW.author_steam_id = COALESCE(
            NEW.author_steam_id, public.hasura_session_steam_id()
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.maps m WHERE m.name = NEW.map_name
    ) THEN
        RAISE EXCEPTION 'Unknown map: %', NEW.map_name USING ERRCODE = '22000';
    END IF;

    -- teams.id is ON DELETE SET NULL, so deleting a team nulls team_id here
    -- while visibility is still 'Team'. The BEFORE trigger runs first, the
    -- CHECK second -- so without demoting, the CHECK aborts the team deletion
    -- itself rather than this row.
    IF TG_OP = 'UPDATE'
       AND OLD.team_id IS NOT NULL
       AND NEW.team_id IS NULL
       AND NEW.visibility = 'Team' THEN
        NEW.visibility = 'Private';
    END IF;

    -- A team lineup has to belong to a team the author is actually on,
    -- otherwise anyone could publish into any team's book. The NULL case is
    -- left to utility_lineups_team_scope_chk, which says so more precisely.
    IF NEW.visibility = 'Team'
       AND NEW.team_id IS NOT NULL
       AND NOT public.is_utility_team_member(NEW.team_id, NEW.author_steam_id) THEN
        RAISE EXCEPTION 'You are not on that team' USING ERRCODE = '22000';
    END IF;

    -- 'exact' claims something MEASURED these coordinates, and it is half of
    -- the plugin's IsExactlyReplayable() gate. Two things can back the claim: a
    -- complete engine seed (the throw can be re-emitted bit for bit), or an
    -- origin that did the measuring -- 'plugin' watched the grenade fly, and
    -- 'fork' is a copy of a row that already passed this same test.
    --
    -- Everything else is somebody's typing. Demoted rather than rejected on
    -- purpose: confidence is not insertable by any non-admin role, so a web
    -- editor insert never asked for 'exact' -- the column default handed it
    -- over -- and failing that insert would be an error about a field the
    -- author cannot see or set.
    IF NEW.confidence = 'exact'
       AND NEW.origin_source NOT IN ('plugin', 'fork')
       AND (
           NEW.initial_pos_x IS NULL OR NEW.initial_pos_y IS NULL
           OR NEW.initial_pos_z IS NULL OR NEW.initial_vel_x IS NULL
           OR NEW.initial_vel_y IS NULL OR NEW.initial_vel_z IS NULL
       ) THEN
        NEW.confidence = CASE
            WHEN NEW.origin_source = 'demo' THEN 'derived'
            ELSE 'low'
        END;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_utility_lineups ON public.utility_lineups;
CREATE TRIGGER tbiu_utility_lineups
    BEFORE INSERT OR UPDATE ON public.utility_lineups
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_utility_lineups();

CREATE OR REPLACE FUNCTION public.tbiu_utility_collections() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();

    -- Ahead of the team check below, which reads owner_steam_id.
    IF TG_OP = 'INSERT' THEN
        NEW.owner_steam_id = COALESCE(
            NEW.owner_steam_id, public.hasura_session_steam_id()
        );
    END IF;

    -- teams.id is ON DELETE SET NULL, so deleting a team nulls team_id here
    -- while visibility is still 'Team'. The BEFORE trigger runs first, the
    -- CHECK second -- so without demoting, the CHECK aborts the team deletion
    -- itself rather than this row.
    IF TG_OP = 'UPDATE'
       AND OLD.team_id IS NOT NULL
       AND NEW.team_id IS NULL
       AND NEW.visibility = 'Team' THEN
        NEW.visibility = 'Private';
    END IF;

    IF NEW.visibility = 'Team'
       AND NEW.team_id IS NOT NULL
       AND NOT public.is_utility_team_member(NEW.team_id, NEW.owner_steam_id) THEN
        RAISE EXCEPTION 'You are not on that team' USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_utility_collections ON public.utility_collections;
CREATE TRIGGER tbiu_utility_collections
    BEFORE INSERT OR UPDATE ON public.utility_collections
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_utility_collections();

-- Counters are maintained here rather than computed on read: the browse index
-- sorts on upvotes, and a computed field cannot be indexed.
CREATE OR REPLACE FUNCTION public.taiud_utility_lineup_votes() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _lineup_id uuid := COALESCE(NEW.utility_lineup_id, OLD.utility_lineup_id);
BEGIN
    UPDATE public.utility_lineups l
       SET upvotes = (
               SELECT COUNT(*) FROM public.utility_lineup_votes v
               WHERE v.utility_lineup_id = _lineup_id AND v.vote = 1
           ),
           downvotes = (
               SELECT COUNT(*) FROM public.utility_lineup_votes v
               WHERE v.utility_lineup_id = _lineup_id AND v.vote = -1
           )
     WHERE l.id = _lineup_id;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taiud_utility_lineup_votes ON public.utility_lineup_votes;
CREATE TRIGGER taiud_utility_lineup_votes
    AFTER INSERT OR UPDATE OR DELETE ON public.utility_lineup_votes
    FOR EACH ROW EXECUTE FUNCTION public.taiud_utility_lineup_votes();

CREATE OR REPLACE FUNCTION public.taid_utility_lineup_favorites() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _lineup_id uuid := COALESCE(NEW.utility_lineup_id, OLD.utility_lineup_id);
BEGIN
    UPDATE public.utility_lineups l
       SET favorites = (
               SELECT COUNT(*) FROM public.utility_lineup_favorites f
               WHERE f.utility_lineup_id = _lineup_id
           )
     WHERE l.id = _lineup_id;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taid_utility_lineup_favorites ON public.utility_lineup_favorites;
CREATE TRIGGER taid_utility_lineup_favorites
    AFTER INSERT OR DELETE ON public.utility_lineup_favorites
    FOR EACH ROW EXECUTE FUNCTION public.taid_utility_lineup_favorites();

-- verified_at is a moderator's manual claim that a lineup works, which at any
-- real library size means it stays null forever and the badge means nothing.
-- A drill already proves the same thing and proves it harder: mastered_at is
-- five consecutive throws inside public.utility_success_radius, recomputed by the
-- API from the stored landing point rather than taken from the game server.
--
-- So verification is derived here instead of waited for. A trigger rather than
-- a sweep because the fact is a property of the child rows -- the same reason
-- the vote counters above are maintained here -- and because the whole
-- never-un-verify guarantee collapses into one idempotent conditional UPDATE
-- that is safe to fire any number of times, from any writer, in any order.
CREATE OR REPLACE FUNCTION public.taiu_utility_lineup_progress_verify() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _required int;
    _masters int;
BEGIN
    IF NEW.mastered_at IS NULL THEN
        RETURN NULL;
    END IF;

    -- Only the crossing into mastery can move the count, so an already-mastered
    -- player throwing all evening costs nothing. Practice results are the
    -- highest-frequency write in the library and this trigger is on their path.
    IF TG_OP = 'UPDATE' AND OLD.mastered_at IS NOT NULL THEN
        RETURN NULL;
    END IF;

    -- A setting somebody typed a word into must not take down every practice
    -- throw on the platform, so an unreadable value falls back rather than
    -- raising.
    BEGIN
        SELECT s.value::int INTO _required
          FROM public.settings s
         WHERE s.name = 'public.utility_verify_masteries';
    EXCEPTION WHEN others THEN
        _required := NULL;
    END;

    IF _required IS NULL OR _required < 1 THEN
        _required := 3;
    END IF;

    -- DISTINCT steam_id, not row count, and it is load-bearing: mastered_at is
    -- writable by a player on their own progress row, so counting rows would
    -- let one account verify anything it liked.
    SELECT count(DISTINCT p.steam_id) INTO _masters
      FROM public.utility_lineup_progress p
     WHERE p.utility_lineup_id = NEW.utility_lineup_id
       AND p.mastered_at IS NOT NULL;

    IF _masters < _required THEN
        RETURN NULL;
    END IF;

    -- verified_at IS NULL is the entire contract: it is why a moderator's own
    -- verification is never restamped or overwritten, and why nothing here can
    -- ever un-verify a lineup. Verification is a claim about the lineup, not
    -- about anybody's current form, so a later miss is not evidence against it.
    BEGIN
        UPDATE public.utility_lineups l
           SET verified_at = now()
         WHERE l.id = NEW.utility_lineup_id
           AND l.verified_at IS NULL;
    EXCEPTION WHEN others THEN
        -- tbiu_utility_lineups re-validates the row on every UPDATE, and a Team
        -- lineup whose author has since left that team raises there. Failing to
        -- verify must never fail the throw that earned the verification.
        RAISE WARNING 'could not verify utility lineup %: %',
            NEW.utility_lineup_id, SQLERRM;
    END;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taiu_utility_lineup_progress_verify ON public.utility_lineup_progress;
CREATE TRIGGER taiu_utility_lineup_progress_verify
    AFTER INSERT OR UPDATE OF mastered_at ON public.utility_lineup_progress
    FOR EACH ROW EXECUTE FUNCTION public.taiu_utility_lineup_progress_verify();

-- The counters public.utility_lineup_difficulty reads. Maintained here because
-- they are a property of the child rows, exactly like the vote counters above.
--
-- NOT folded into taiu_utility_lineup_progress_verify, which is the obvious place
-- and the wrong one: that trigger is AFTER UPDATE OF mastered_at and returns
-- immediately unless mastery is crossing from null, which is the one throw in
-- a career that these counters do not care about specially. Difficulty moves on
-- every attempt.
--
-- Deltas rather than a re-aggregate. The vote counters can afford COUNT(*)
-- over their children because a vote is a rare, human-paced write; this fires
-- on the highest-frequency write in the library, and a popular lineup holds a
-- progress row for every player who ever opened it.
CREATE OR REPLACE FUNCTION public.taiud_utility_lineup_progress_counters() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _lineup_id uuid := COALESCE(NEW.utility_lineup_id, OLD.utility_lineup_id);
    _players int;
    _attempts int;
    _successes int;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- A row is written the moment a lineup is opened, so a player only
        -- counts once they have actually thrown at it.
        _players := (NEW.attempts > 0)::int;
        _attempts := NEW.attempts;
        _successes := NEW.successes;
    ELSIF TG_OP = 'DELETE' THEN
        _players := -(OLD.attempts > 0)::int;
        _attempts := -OLD.attempts;
        _successes := -OLD.successes;
    ELSE
        _players := (NEW.attempts > 0)::int - (OLD.attempts > 0)::int;
        _attempts := NEW.attempts - OLD.attempts;
        _successes := NEW.successes - OLD.successes;
    END IF;

    IF _players = 0 AND _attempts = 0 AND _successes = 0 THEN
        RETURN NULL;
    END IF;

    BEGIN
        UPDATE public.utility_lineups l
           SET practice_players = GREATEST(0, l.practice_players + _players),
               practice_attempts = GREATEST(0, l.practice_attempts + _attempts),
               practice_successes = GREATEST(0, l.practice_successes + _successes)
         WHERE l.id = _lineup_id;
    EXCEPTION WHEN others THEN
        -- tbiu_utility_lineups re-validates the whole row on every UPDATE, and a
        -- Team lineup whose author has since left that team raises there.
        -- Losing a counter must never fail the throw that moved it.
        RAISE WARNING 'could not count practice on utility lineup %: %',
            _lineup_id, SQLERRM;
    END;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taiud_utility_lineup_progress_counters ON public.utility_lineup_progress;
CREATE TRIGGER taiud_utility_lineup_progress_counters
    AFTER INSERT OR DELETE OR UPDATE OF attempts, successes
    ON public.utility_lineup_progress
    FOR EACH ROW EXECUTE FUNCTION public.taiud_utility_lineup_progress_counters();

-- The miss offsets are vectors measured against ONE target point and one throw
-- axis. Move either and every accumulated sum describes a lineup that no longer
-- exists -- the pattern would go on confidently coaching the old throw. The
-- attempt counters are deliberately left alone: those are a record that
-- somebody practised, which an edit does not undo.
CREATE OR REPLACE FUNCTION public.tau_utility_lineups_reset_offsets() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.land_x IS NOT DISTINCT FROM OLD.land_x
       AND NEW.land_y IS NOT DISTINCT FROM OLD.land_y
       AND NEW.land_z IS NOT DISTINCT FROM OLD.land_z
       AND NEW.view_yaw IS NOT DISTINCT FROM OLD.view_yaw
       AND NEW.origin_x IS NOT DISTINCT FROM OLD.origin_x
       AND NEW.origin_y IS NOT DISTINCT FROM OLD.origin_y THEN
        RETURN NULL;
    END IF;

    UPDATE public.utility_lineup_progress p
       SET miss_samples = 0,
           miss_along_sum = 0,
           miss_lateral_sum = 0,
           miss_vertical_sum = 0
     WHERE p.utility_lineup_id = NEW.id
       AND p.miss_samples > 0;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_utility_lineups_reset_offsets ON public.utility_lineups;
CREATE TRIGGER tau_utility_lineups_reset_offsets
    AFTER UPDATE OF land_x, land_y, land_z, view_yaw, origin_x, origin_y
    ON public.utility_lineups
    FOR EACH ROW EXECUTE FUNCTION public.tau_utility_lineups_reset_offsets();

-- Who may publish to the shared library.
--
-- This is a trigger rather than a Hasura permission check on purpose: a check
-- only sees the row AFTER the write, so "visibility <> Public" would also
-- reject an author editing the name of a lineup that is already public. Only a
-- trigger can see that this is a TRANSITION into Public.
--
-- current_setting('hasura.user') is set by Hasura on every request it proxies.
-- A direct connection from the API has no such setting and is trusted: that is
-- our own server, not a caller.
CREATE OR REPLACE FUNCTION public.tbiu_utility_lineups_public() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _session json;
    _role text;
    _steam_id bigint;
BEGIN
    IF NOT (
        NEW.visibility = 'Public'
        AND (TG_OP = 'INSERT' OR OLD.visibility IS DISTINCT FROM 'Public')
    ) THEN
        -- Editing a lineup must never read as a fresh request, so a pending
        -- request is only cleared by a review or by the author withdrawing it.
        RETURN NEW;
    END IF;

    _session := NULLIF(current_setting('hasura.user', true), '')::json;
    _role := _session ->> 'x-hasura-role';
    _steam_id := NULLIF(_session ->> 'x-hasura-user-id', '')::bigint;

    IF _session IS NOT NULL
       AND _role IS DISTINCT FROM 'admin'
       AND _role IS DISTINCT FROM 'administrator'
       AND _role IS DISTINCT FROM 'moderator'
    THEN
        RAISE EXCEPTION
            'A lineup becomes public by review. Submit it and a moderator will look at it.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Stamped here rather than by the caller so it cannot be forged, and so an
    -- approval always records who approved it.
    NEW.public_reviewed_at := now();
    NEW.public_reviewed_by := COALESCE(_steam_id, NEW.public_reviewed_by);
    NEW.public_requested_at := NULL;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_utility_lineups_public ON public.utility_lineups;
CREATE TRIGGER tbiu_utility_lineups_public
    BEFORE INSERT OR UPDATE ON public.utility_lineups
    FOR EACH ROW
    EXECUTE FUNCTION public.tbiu_utility_lineups_public();

-- Favourites, votes and progress are all "this player, this lineup" rows, and
-- none of them has a BEFORE trigger of its own to stamp the owner in.
DROP TRIGGER IF EXISTS tbi_utility_lineup_favorites_steam_id ON public.utility_lineup_favorites;
CREATE TRIGGER tbi_utility_lineup_favorites_steam_id
    BEFORE INSERT ON public.utility_lineup_favorites
    FOR EACH ROW EXECUTE FUNCTION public.tbi_stamp_session_steam_id('steam_id');

DROP TRIGGER IF EXISTS tbi_utility_lineup_votes_steam_id ON public.utility_lineup_votes;
CREATE TRIGGER tbi_utility_lineup_votes_steam_id
    BEFORE INSERT ON public.utility_lineup_votes
    FOR EACH ROW EXECUTE FUNCTION public.tbi_stamp_session_steam_id('steam_id');

DROP TRIGGER IF EXISTS tbi_utility_lineup_progress_steam_id ON public.utility_lineup_progress;
CREATE TRIGGER tbi_utility_lineup_progress_steam_id
    BEFORE INSERT ON public.utility_lineup_progress
    FOR EACH ROW EXECUTE FUNCTION public.tbi_stamp_session_steam_id('steam_id');
