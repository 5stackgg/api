-- Turns a free agent pool into balanced pickup teams. Returns the number of
-- teams created.
--
-- TWO STAGES, deliberately not merged:
--   1. Selection -- who plays at all -- is decided by registration order alone.
--   2. Assignment -- which team a selected player lands on -- is decided by ELO.
-- Collapsing them would let a late high-ELO signup take the slot of someone who
-- registered hours earlier, which is the one thing a first-come pool must not do.
CREATE OR REPLACE FUNCTION public.draft_tournament_free_agent_teams(_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _team_size int;
    _max_teams int;
    _pool uuid[];
    _eligible int;
    _teams int;
    _selected int;
    _existing_teams int;
    _steam_ids bigint[];
    _team_indexes int[];
    _team_ids uuid[] := '{}';
    _team_index int;
    _slot int;
    _owner bigint;
    _new_team_id uuid;
BEGIN
    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = _tournament_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    -- Idempotent on the DRAFTED teams only. Guarding on "any team exists" would
    -- mean registration_type = 'both' never drafted at all: the first team that
    -- registered normally would permanently block the free-agent pool, when the
    -- whole point of 'both' is to top the field up with it.
    IF EXISTS (
        SELECT 1 FROM public.tournament_teams tt
        WHERE tt.tournament_id = _tournament_id AND tt.is_drafted
    ) THEN
        RETURN 0;
    END IF;

    _team_size := COALESCE(
        public.tournament_min_players_per_lineup(_tournament),
        public.tournament_max_players_per_lineup(_tournament)
    );

    IF _team_size IS NULL OR _team_size < 1 THEN
        RETURN 0;
    END IF;

    SELECT ts.max_teams INTO _max_teams
    FROM public.tournament_stages ts
    WHERE ts.tournament_id = _tournament_id AND ts."order" = 1
    LIMIT 1;

    SELECT COUNT(*) INTO _existing_teams
    FROM public.tournament_teams tt
    WHERE tt.tournament_id = _tournament_id;

    -- Stage 1: selection. created_at ASC and nothing else.
    --
    -- A free agent who also ended up on a registered roster is skipped rather
    -- than drafted: tournament_team_roster is unique per (tournament, player),
    -- so drafting them would abort the whole transition on a key violation.
    SELECT array_agg(fa.id ORDER BY fa.created_at, fa.id)
    INTO _pool
    FROM public.tournament_free_agents fa
    WHERE fa.tournament_id = _tournament_id
      AND (
          fa.status = 'registered'
          OR (fa.status = 'waitlisted' AND fa.checked_in_at IS NOT NULL)
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.tournament_team_roster ttr
          WHERE ttr.tournament_id = _tournament_id
            AND ttr.player_steam_id = fa.player_steam_id
      );

    _eligible := COALESCE(array_length(_pool, 1), 0);

    IF _eligible = 0 THEN
        RETURN 0;
    END IF;

    _teams := _eligible / _team_size;

    -- The cap is the bracket's remaining room, not its total size: in 'both'
    -- mode the teams that registered normally have already taken their slots.
    IF _max_teams IS NOT NULL AND _teams > GREATEST(_max_teams - _existing_teams, 0) THEN
        _teams := GREATEST(_max_teams - _existing_teams, 0);
    END IF;

    _selected := _teams * _team_size;

    -- Everyone past the cut waits. created_at is untouched, so a later pass
    -- still honours the order they signed up in.
    UPDATE public.tournament_free_agents fa
       SET status = 'waitlisted',
           tournament_team_id = NULL
     WHERE fa.id = ANY(_pool[(_selected + 1):_eligible]);

    IF _teams < 1 THEN
        RETURN 0;
    END IF;

    -- Stage 2: assignment. The shuffle exists only so equal-rated players do not
    -- always land on the same side of the snake; it never reorders the pool.
    WITH selected AS MATERIALIZED (
        SELECT
            fa.player_steam_id,
            COALESCE(public.get_tournament_player_elo(_tournament_id, fa.player_steam_id), 5000) AS elo,
            -- Drawn once per player and stored, not called from the ORDER BY:
            -- a volatile function re-evaluated mid-sort gives an undefined order
            -- rather than a shuffle.
            random() AS shuffle
        FROM public.tournament_free_agents fa
        WHERE fa.id = ANY(_pool[1:_selected])
    ),
    ordered AS (
        SELECT s.*, ROW_NUMBER() OVER (ORDER BY s.elo DESC, s.shuffle) AS pick
        FROM selected s
    ),
    snake AS (
        SELECT
            o.*,
            CASE WHEN ((o.pick - 1) / _teams) % 2 = 0
                 THEN ((o.pick - 1) % _teams) + 1
                 ELSE _teams - ((o.pick - 1) % _teams)
            END::int AS team_index
        FROM ordered o
    )
    SELECT
        array_agg(s.player_steam_id ORDER BY s.team_index, s.elo DESC, s.player_steam_id),
        array_agg(s.team_index      ORDER BY s.team_index, s.elo DESC, s.player_steam_id)
    INTO _steam_ids, _team_indexes
    FROM snake s;

    -- tbi_tournament_team_roster redirects a non-organizer insert on a pickup
    -- team into an INVITE. These players never invited each other, so the
    -- redirect would silently produce empty teams; the named GUC marks the
    -- system path the same way fivestack.league_cascade does. It is transaction
    -- local, so an error rolls it back with everything else.
    PERFORM set_config('fivestack.free_agent_draft', 'true', true);

    FOR _team_index IN 1.._teams LOOP
        -- There is no real owner for a pool of strangers; the highest-rated
        -- player on the generated roster is the least arbitrary stand-in for
        -- the NOT NULL owner/captain columns.
        _owner := _steam_ids[array_position(_team_indexes, _team_index)];

        -- Numbered past the teams that are already in, so 'both' does not mint a
        -- second "Team 1" next to a registered one. checked_in_at is stamped
        -- outright: a team that did not exist while the window was open cannot
        -- be a no-show, and leaving it NULL would drop every drafted team back
        -- out of seeding.
        INSERT INTO public.tournament_teams (tournament_id, team_id, name, owner_steam_id, captain_steam_id, is_drafted, checked_in_at)
        VALUES (_tournament_id, NULL, 'Team ' || (_existing_teams + _team_index), _owner, _owner, true, now())
        RETURNING id INTO _new_team_id;

        _team_ids := array_append(_team_ids, _new_team_id);
    END LOOP;

    FOR _slot IN 1..array_length(_steam_ids, 1) LOOP
        INSERT INTO public.tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
        VALUES (
            _team_ids[_team_indexes[_slot]],
            _steam_ids[_slot],
            _tournament_id,
            -- The arrays are sorted by (team_index, elo desc), so the first slot
            -- of each team is its owner.
            CASE WHEN _slot = array_position(_team_indexes, _team_indexes[_slot]) THEN 'Admin' ELSE 'Member' END
        );

        UPDATE public.tournament_free_agents fa
           SET status = 'drafted',
               tournament_team_id = _team_ids[_team_indexes[_slot]]
         WHERE fa.tournament_id = _tournament_id
           AND fa.player_steam_id = _steam_ids[_slot];
    END LOOP;

    PERFORM set_config('fivestack.free_agent_draft', 'false', true);

    RETURN _teams;
END;
$$;
