-- Turns a free agent pool into balanced pickup teams. Returns the number of
-- teams created.
--
-- Selection (who plays at all) is registration order alone and assignment
-- (which team) is ELO; merging them would let a late high-ELO signup take the
-- slot of someone who registered hours earlier.
CREATE OR REPLACE FUNCTION public.draft_tournament_free_agent_teams(_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _team_size int;
    _max_teams int;
    _existing_teams int;
    _pool_ids uuid[];
    _selected_ids uuid[];
    _teams int;
    _team_sizes int[];
    _team_totals numeric[];
    _agent record;
    _best int;
    _team int;
    _steam_ids bigint[] := '{}';
    _team_indexes int[] := '{}';
    _elos numeric[] := '{}';
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

    -- A free agent who also ended up on a registered roster is skipped rather
    -- than drafted: tournament_team_roster is unique per (tournament, player),
    -- so drafting them would abort the whole transition on a key violation.
    --
    -- Owning a team counts as being in the tournament even with no roster row.
    SELECT array_agg(fa.id ORDER BY fa.created_at, fa.id)
    INTO _pool_ids
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
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.tournament_teams tt
          WHERE tt.tournament_id = _tournament_id
            AND tt.owner_steam_id = fa.player_steam_id
      );

    IF _pool_ids IS NULL THEN
        RETURN 0;
    END IF;

    _teams := array_length(_pool_ids, 1) / _team_size;

    -- The cap is the bracket's remaining room, not its total size: in 'both'
    -- mode the teams that registered normally have already taken their slots.
    IF _max_teams IS NOT NULL THEN
        _teams := LEAST(_teams, GREATEST(_max_teams - _existing_teams, 0));
    END IF;

    -- Before any status write, never after: waitlisting is one way (the pool
    -- only re-admits a waitlisted agent who has checked in, which needs
    -- check_in_required), so a draft that creates nothing must leave the pool
    -- exactly as it found it. Otherwise an organizer clicking "Draft Teams" on
    -- three early signups buries all three permanently, and the seven who
    -- register afterwards take the team those three were queued for -- the
    -- precise inversion the created_at rule exists to prevent.
    IF _teams < 1 THEN
        RETURN 0;
    END IF;

    -- Stage 1: selection, in sign-up order. Everyone past the last full team
    -- waits; created_at is untouched, so a later pass still honours the order
    -- they signed up in.
    _selected_ids := _pool_ids[1:_teams * _team_size];

    UPDATE public.tournament_free_agents fa
       SET status = 'waitlisted',
           tournament_team_id = NULL
     WHERE fa.id = ANY(_pool_ids)
       AND fa.id <> ALL(_selected_ids);

    -- Stage 2: assignment. Strongest player first onto the team with the lowest
    -- running total that still has room.
    --
    -- The shuffle exists only so equal-rated players do not always land on the
    -- same side of the draft; it never reorders the pool. Drawn once per player
    -- and stored, not called from the ORDER BY: a volatile function
    -- re-evaluated mid-sort gives an undefined order rather than a shuffle.
    _team_sizes := array_fill(0, ARRAY[_teams]);
    _team_totals := array_fill(0::numeric, ARRAY[_teams]);

    FOR _agent IN
        WITH rated AS MATERIALIZED (
            SELECT fa.player_steam_id,
                   COALESCE(public.get_tournament_player_elo(_tournament_id, fa.player_steam_id), 5000) AS elo,
                   random() AS shuffle
              FROM public.tournament_free_agents fa
             WHERE fa.id = ANY(_selected_ids)
        )
        SELECT r.player_steam_id, r.elo
          FROM rated r
         ORDER BY r.elo DESC, r.shuffle
    LOOP
        _best := NULL;

        FOR _team IN 1.._teams LOOP
            IF _team_sizes[_team] < _team_size
               AND (_best IS NULL OR _team_totals[_team] < _team_totals[_best]) THEN
                _best := _team;
            END IF;
        END LOOP;

        _team_sizes[_best] := _team_sizes[_best] + 1;
        _team_totals[_best] := _team_totals[_best] + _agent.elo;
        _steam_ids := array_append(_steam_ids, _agent.player_steam_id);
        _team_indexes := array_append(_team_indexes, _best);
        _elos := array_append(_elos, _agent.elo);
    END LOOP;

    SELECT array_agg(d.steam_id ORDER BY d.team_index, d.elo DESC, d.steam_id),
           array_agg(d.team_index ORDER BY d.team_index, d.elo DESC, d.steam_id)
      INTO _steam_ids, _team_indexes
      FROM unnest(_steam_ids, _team_indexes, _elos) AS d(steam_id, team_index, elo);

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
