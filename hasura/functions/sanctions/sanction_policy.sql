-- The configurable sanctions policy.
--
-- Every automatic sanction on the platform is described by five numbers held in
-- `public.settings` under `public.sanction_<source>_<field>`: enabled,
-- threshold, window_days, durations and scope. The `public.` prefix is the ACL
-- (guest may read a public.% setting), which is what lets the UI tell a player
-- why they are on cooldown instead of just that they are.
--
-- Nothing here reads a hardcoded number. A missing or unparseable settings row
-- falls back to `e_sanction_sources.default_*`, never to "no sanction": a
-- deleted row or a typo must not silently switch enforcement off.
--
-- Ordering note: apply() walks hasura/functions alphabetically, so this file
-- runs after players/ and before tournaments/. Everything below is plpgsql or
-- only calls functions defined above it, so nothing resolves a body at CREATE
-- time against a function that does not exist yet.

CREATE OR REPLACE FUNCTION public.sanction_policy_enabled(_source text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (
            SELECT s.value = 'true'
              FROM public.settings s
             WHERE s.name = 'public.sanction_' || _source || '_enabled'
        ),
        src.default_enabled
    )
    FROM public.e_sanction_sources src
    WHERE src.value = _source;
$$;

-- Clamped to 1: a threshold of 0 would mean "fires with no occurrences at all",
-- which would ban the entire player base the moment it was typed.
--
-- plpgsql rather than sql, here and below, purely for creation order: a sql body
-- is resolved at CREATE time and get_int_setting/get_setting live in
-- hasura/functions/settings, which apply() reaches after this directory.
CREATE OR REPLACE FUNCTION public.sanction_policy_threshold(_source text)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _default integer;
BEGIN
    SELECT src.default_threshold
      INTO _default
      FROM public.e_sanction_sources src
     WHERE src.value = _source;

    IF _default IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN GREATEST(
        1,
        public.get_int_setting(
            'public.sanction_' || _source || '_threshold',
            _default
        )
    );
END;
$$;

-- How far back occurrences count. 0 means the source never decays -- what a VAC
-- ban needs, and what the leaver window explicitly does not.
CREATE OR REPLACE FUNCTION public.sanction_policy_window_days(_source text)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _default integer;
BEGIN
    SELECT src.default_window_days
      INTO _default
      FROM public.e_sanction_sources src
     WHERE src.value = _source;

    IF _default IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN GREATEST(
        0,
        public.get_int_setting(
            'public.sanction_' || _source || '_window_days',
            _default
        )
    );
END;
$$;

-- The escalation ladder, in minutes, indexed by occurrence count clamped to its
-- length. A single entry is a flat penalty; 0 means the sanction never lifts.
CREATE OR REPLACE FUNCTION public.sanction_policy_durations(_source text)
RETURNS integer[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _default text;
    _raw text;
    _parsed integer[];
BEGIN
    SELECT src.default_durations
      INTO _default
      FROM public.e_sanction_sources src
     WHERE src.value = _source;

    IF _default IS NULL THEN
        RETURN NULL;
    END IF;

    _raw := public.get_setting(
        'public.sanction_' || _source || '_durations',
        _default
    );

    -- A ladder that does not parse falls back to the shipped one rather than to
    -- an empty array: a stray character in the settings field would otherwise
    -- disable the sanction without saying so anywhere.
    IF _raw !~ '^\s*\d+\s*(,\s*\d+\s*)*$' THEN
        _raw := _default;
    END IF;

    SELECT array_agg(trim(part)::integer ORDER BY position)
      INTO _parsed
      FROM regexp_split_to_table(_raw, ',')
           WITH ORDINALITY AS entry(part, position);

    RETURN _parsed;
END;
$$;

-- Joined against the scope enum so a value that is not one of the three falls
-- back to the shipped scope instead of matching nothing and quietly disabling
-- the source everywhere.
CREATE OR REPLACE FUNCTION public.sanction_policy_scope(_source text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (
            SELECT sc.value
              FROM public.settings s
              JOIN public.e_sanction_scopes sc ON sc.value = s.value
             WHERE s.name = 'public.sanction_' || _source || '_scope'
        ),
        src.default_scope
    )
    FROM public.e_sanction_sources src
    WHERE src.value = _source;
$$;

CREATE OR REPLACE FUNCTION public.sanction_policy_covers(_source text, _scope text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT public.sanction_policy_scope(_source) IN ('both', _scope);
$$;

-- Occurrence count and the most recent occurrence, per source, already narrowed
-- to the source's decay window. Every source answers the same two questions;
-- only the table they are asked of differs.
CREATE OR REPLACE FUNCTION public.sanction_occurrences(_source text, _steam_id bigint)
RETURNS TABLE (occurrence_count integer, last_occurred_at timestamptz)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _window integer;
    _cutoff timestamptz;
BEGIN
    _window := public.sanction_policy_window_days(_source);

    IF _window IS NULL THEN
        RETURN;
    END IF;

    _cutoff := CASE
        WHEN _window > 0 THEN now() - make_interval(days => _window)
        ELSE '-infinity'::timestamptz
    END;

    IF _source = 'match_abandon' THEN
        RETURN QUERY
            SELECT COUNT(*)::integer, MAX(am.abandoned_at)
              FROM public.abandoned_matches am
             WHERE am.steam_id = _steam_id
               AND am.abandoned_at > _cutoff;
    ELSIF _source = 'tournament_no_show' THEN
        RETURN QUERY
            SELECT COUNT(*)::integer, MAX(ns.occurred_at)
              FROM public.tournament_no_shows ns
             WHERE ns.player_steam_id = _steam_id
               AND ns.occurred_at > _cutoff;
    ELSIF _source = 'vac_ban' THEN
        -- Steam is the record here, not a table of ours: the occurrence count
        -- is how many VAC bans the account carries and the occurrence time is
        -- derived from days_since_last_ban, both refreshed by SteamBansService
        -- before it decides anything.
        RETURN QUERY
            SELECT GREATEST(p.vac_ban_count, 1),
                   now() - make_interval(days => COALESCE(p.days_since_last_ban, 0))
              FROM public.players p
             WHERE p.steam_id = _steam_id
               AND (p.vac_banned OR p.vac_ban_count > 0)
               AND now() - make_interval(days => COALESCE(p.days_since_last_ban, 0)) > _cutoff;
    END IF;

    RETURN;
END;
$$;

-- When a sanction earned by `_count` occurrences ending at `_last_occurred_at`
-- lifts, or NULL when the policy does not fire at all.
--
-- The clock runs from the last occurrence rather than from now(), which is what
-- the leaver cooldown has always done: a penalty computed twice for the same
-- record must land on the same instant, or every recount would extend it.
-- 'infinity' is how a ladder entry of 0 -- a sanction with no end -- comes back.
CREATE OR REPLACE FUNCTION public.sanction_expiry(
    _source text,
    _count integer,
    _last_occurred_at timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _durations integer[];
    _minutes integer;
BEGIN
    IF _count IS NULL OR _count < 1 OR _last_occurred_at IS NULL THEN
        RETURN NULL;
    END IF;

    IF NOT COALESCE(public.sanction_policy_enabled(_source), false) THEN
        RETURN NULL;
    END IF;

    IF _count < public.sanction_policy_threshold(_source) THEN
        RETURN NULL;
    END IF;

    _durations := public.sanction_policy_durations(_source);

    IF _durations IS NULL OR array_length(_durations, 1) IS NULL THEN
        RETURN NULL;
    END IF;

    _minutes := _durations[LEAST(_count, array_length(_durations, 1))];

    IF _minutes = 0 THEN
        RETURN 'infinity'::timestamptz;
    END IF;

    RETURN _last_occurred_at + make_interval(mins => _minutes);
END;
$$;

-- player_sanctions spells "permanent" as a NULL remove_sanction_date, and every
-- reader of that table -- is_banned, banned_until, the game plugins -- already
-- understands that spelling and none of them understand infinity.
CREATE OR REPLACE FUNCTION public.sanction_remove_date(
    _source text,
    _count integer,
    _last_occurred_at timestamptz
)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(
        public.sanction_expiry(_source, _count, _last_occurred_at),
        'infinity'::timestamptz
    );
$$;

CREATE OR REPLACE FUNCTION public.player_source_sanction_expiry(_source text, _steam_id bigint)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _occurrences record;
BEGIN
    SELECT * INTO _occurrences FROM public.sanction_occurrences(_source, _steam_id);

    IF NOT FOUND OR COALESCE(_occurrences.occurrence_count, 0) = 0 THEN
        RETURN NULL;
    END IF;

    RETURN public.sanction_expiry(
        _source,
        _occurrences.occurrence_count,
        _occurrences.last_occurred_at
    );
END;
$$;

-- The one gate every scoped caller asks: when, if ever, is this player allowed
-- back into `_scope`. NULL means never sanctioned or already served.
CREATE OR REPLACE FUNCTION public.player_sanction_expiry(_steam_id bigint, _scope text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _source record;
    _expiry timestamptz;
    _latest timestamptz;
BEGIN
    IF _steam_id IS NULL THEN
        RETURN NULL;
    END IF;

    FOR _source IN
        SELECT value, writes_platform_ban FROM public.e_sanction_sources
    LOOP
        IF NOT COALESCE(public.sanction_policy_covers(_source.value, _scope), false) THEN
            CONTINUE;
        END IF;

        -- A source that writes a real player_sanctions ban and is scoped to the
        -- whole platform is already enforced by is_banned() everywhere. Counting
        -- it again here would put an end date on the matchmaking cooldown field
        -- for a ban that has none -- and would show a cooldown where, before any
        -- of this was configurable, there was none to show.
        IF _source.writes_platform_ban
           AND public.sanction_policy_scope(_source.value) = 'both' THEN
            CONTINUE;
        END IF;

        _expiry := public.player_source_sanction_expiry(_source.value, _steam_id);

        IF _expiry IS NOT NULL AND (_latest IS NULL OR _expiry > _latest) THEN
            _latest := _expiry;
        END IF;
    END LOOP;

    RETURN _latest;
END;
$$;

-- Computed-field shape, for the profile and the tournament join screen. Mirrors
-- get_player_matchmaking_cooldown: only the player themselves may see it, and it
-- reads NULL once the sanction has been served.
CREATE OR REPLACE FUNCTION public.get_player_tournament_cooldown(
    player public.players,
    hasura_session json
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    cooldown_time timestamptz;
BEGIN
    IF (hasura_session ->> 'x-hasura-user-id')::bigint IS DISTINCT FROM player.steam_id::bigint THEN
        RETURN NULL;
    END IF;

    cooldown_time := public.player_sanction_expiry(player.steam_id, 'tournaments');

    IF cooldown_time > now() THEN
        RETURN cooldown_time;
    END IF;

    RETURN NULL;
END;
$$;

-- Records one no-show occurrence per rostered player of every team that missed a
-- required check-in, and the entry point the check-in job calls.
--
-- Only teams that could actually have been seeded count, the same rule
-- tournament_missed_check_in_count applies: a half-filled roster was never going
-- to play whether it confirmed or not, so penalising it would punish players for
-- a registration that was already dead.
CREATE OR REPLACE FUNCTION public.record_tournament_no_shows(_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _recorded integer;
BEGIN
    IF NOT COALESCE(public.sanction_policy_enabled('tournament_no_show'), false) THEN
        RETURN 0;
    END IF;

    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = _tournament_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- Nobody misses a prompt that never appeared. Without an opened window there
    -- was no check-in to miss, and every rostered player in the tournament would
    -- be penalised for the organizer closing registration early.
    IF NOT public.tournament_check_in_window_opened(_tournament) THEN
        RETURN 0;
    END IF;

    INSERT INTO public.tournament_no_shows
        (tournament_id, tournament_team_id, player_steam_id)
    SELECT tt.tournament_id, tt.id, ttr.player_steam_id
      FROM public.tournament_teams tt
      JOIN public.tournament_team_roster ttr ON ttr.tournament_team_id = tt.id
     WHERE tt.tournament_id = _tournament_id
       AND tt.checked_in_at IS NULL
       AND public.tournament_team_lineup_filled(tt)
    ON CONFLICT (tournament_id, player_steam_id) DO NOTHING;

    GET DIAGNOSTICS _recorded = ROW_COUNT;

    RETURN _recorded;
END;
$$;
