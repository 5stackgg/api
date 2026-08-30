-- Turns a free agent pool into balanced pickup teams. Returns the number of
-- teams created.
--
-- TWO STAGES, deliberately not merged:
--   1. Selection -- who plays at all -- is decided by registration order alone.
--   2. Assignment -- which team a selected player lands on -- is decided by ELO.
-- Collapsing them would let a late high-ELO signup take the slot of someone who
-- registered hours earlier, which is the one thing a first-come pool must not do.
--
-- Both stages work on UNITS, not players. A unit is everyone sharing a party_id
-- (the lobby they signed up from), or a single agent with no party. A unit is
-- indivisible and its priority is its EARLIEST member's signup: joining a party
-- can neither buy a late signup an earlier place nor cost the early member the
-- place they already held.
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
    _unit_keys text[];
    _unit_sizes int[];
    _unit_elos numeric[];
    _unit_count int;
    _unit_team int[];
    _elo_order int[];
    _teams int;
    _packed boolean := false;
    _bin_room int[];
    _bin_totals numeric[];
    _slot_bin int[];
    _slot_size int[];
    _slot_used boolean[];
    _slot_count int;
    _best int;
    _selected_keys text[] := '{}';
    _selected_teams int[] := '{}';
    _steam_ids bigint[];
    _team_indexes int[];
    _team_ids uuid[] := '{}';
    _team_index int;
    _slot int;
    _unit int;
    _bin int;
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
    -- tournament_teams is UNIQUE (owner_steam_id, tournament_id) and every
    -- generated team takes its top-rated player as owner, so drafting one of
    -- these would raise a duplicate key -- inside tau_tournaments, which rolls
    -- the entire RegistrationOpen -> RegistrationClosed transition back and
    -- fails identically on every retry, with no way for the organizer out.
    --
    -- Both guards are PER MEMBER: an ineligible member shrinks their party by
    -- one rather than knocking the whole party out. The rest of the party did
    -- nothing wrong.
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

    -- Stage 1: selection. Units in priority order -- earliest member first, so
    -- a party queues where its founder queued.
    WITH pooled AS (
        SELECT fa.id,
               fa.created_at,
               COALESCE(fa.party_id::text, 'solo:' || fa.id::text) AS unit_key,
               COALESCE(public.get_tournament_player_elo(_tournament_id, fa.player_steam_id), 5000) AS elo
          FROM public.tournament_free_agents fa
         WHERE fa.id = ANY(_pool_ids)
    ),
    units AS (
        SELECT p.unit_key,
               COUNT(*)::int AS size,
               MIN(p.created_at) AS first_at,
               MIN(p.id::text) AS first_id,
               SUM(p.elo) AS elo
          FROM pooled p
         GROUP BY p.unit_key
    )
    SELECT array_agg(u.unit_key ORDER BY u.first_at, u.first_id),
           array_agg(u.size ORDER BY u.first_at, u.first_id),
           array_agg(u.elo ORDER BY u.first_at, u.first_id)
      INTO _unit_keys, _unit_sizes, _unit_elos
      FROM units u;

    _unit_count := array_length(_unit_keys, 1);

    _teams := array_length(_pool_ids, 1) / _team_size;

    -- The cap is the bracket's remaining room, not its total size: in 'both'
    -- mode the teams that registered normally have already taken their slots.
    IF _max_teams IS NOT NULL THEN
        _teams := LEAST(_teams, GREATEST(_max_teams - _existing_teams, 0));
    END IF;

    -- Pack the units into _teams bins of _team_size, first fit, in priority
    -- order. A unit that fits nowhere is SKIPPED and the walk continues, so a
    -- five-stack arriving early cannot strand four slots in a Wingman draft and
    -- the duos behind it still get in. That is a deliberate departure from
    -- strict priority -- the alternative is either splitting the party or
    -- throwing away capacity the rest of the pool could have used.
    --
    -- The bins are a feasibility device, not the teams: a set of units whose
    -- sizes merely SUM to the capacity is not necessarily playable (4+4+2 into
    -- two teams of five sums right and packs nowhere). Only an exact pack is
    -- accepted, and the bracket shrinks by a team and is retried until one is
    -- found. What survives is the multiset of unit sizes per team, which is
    -- what stage 2 fills.
    WHILE _teams >= 1 AND NOT _packed LOOP
        _bin_room := array_fill(_team_size, ARRAY[_teams]);
        _slot_bin := '{}';
        _slot_size := '{}';
        _unit_team := array_fill(0, ARRAY[_unit_count]);

        FOR _unit IN 1.._unit_count LOOP
            FOR _bin IN 1.._teams LOOP
                IF _bin_room[_bin] >= _unit_sizes[_unit] THEN
                    _bin_room[_bin] := _bin_room[_bin] - _unit_sizes[_unit];
                    _slot_bin := array_append(_slot_bin, _bin);
                    _slot_size := array_append(_slot_size, _unit_sizes[_unit]);
                    _unit_team[_unit] := _bin;
                    EXIT;
                END IF;
            END LOOP;
        END LOOP;

        _packed := NOT EXISTS (SELECT 1 FROM unnest(_bin_room) AS room WHERE room <> 0);

        IF NOT _packed THEN
            _teams := _teams - 1;
        END IF;
    END LOOP;

    -- Before any status write, never after: waitlisting is one way (the pool
    -- only re-admits a waitlisted agent who has checked in, which needs
    -- check_in_required), so a draft that creates nothing must leave the pool
    -- exactly as it found it. Otherwise an organizer clicking "Draft Teams" on
    -- three early signups buries all three permanently, and the seven who
    -- register afterwards take the team those three were queued for -- the
    -- precise inversion the created_at rule exists to prevent.
    IF NOT _packed THEN
        RETURN 0;
    END IF;

    -- Stage 2: assignment. Strongest unit first into the team with the lowest
    -- running total that still has a free slot OF THAT SIZE. Restricting to a
    -- slot of the unit's own size is what keeps the teams exact: stage 1 built
    -- the slots out of these very units, so the number of unplaced units of any
    -- size always equals the number of free slots of that size and every unit
    -- is guaranteed a home.
    --
    -- The shuffle exists only so equal-rated units do not always land on the
    -- same side of the draft; it never reorders the pool. Drawn once per unit
    -- and stored, not called from the ORDER BY: a volatile function
    -- re-evaluated mid-sort gives an undefined order rather than a shuffle.
    WITH shuffled AS MATERIALIZED (
        SELECT unit, random() AS shuffle
        FROM generate_series(1, _unit_count) AS unit
    )
    SELECT array_agg(s.unit ORDER BY _unit_elos[s.unit] DESC, s.shuffle)
      INTO _elo_order
      FROM shuffled s;

    _slot_count := array_length(_slot_bin, 1);
    _slot_used := array_fill(false, ARRAY[_slot_count]);
    _bin_totals := array_fill(0::numeric, ARRAY[_teams]);

    FOREACH _unit IN ARRAY _elo_order LOOP
        IF _unit_team[_unit] = 0 THEN
            CONTINUE;
        END IF;

        _best := NULL;

        FOR _slot IN 1.._slot_count LOOP
            IF NOT _slot_used[_slot]
               AND _slot_size[_slot] = _unit_sizes[_unit]
               AND (
                   _best IS NULL
                   OR _bin_totals[_slot_bin[_slot]] < _bin_totals[_slot_bin[_best]]
               ) THEN
                _best := _slot;
            END IF;
        END LOOP;

        _slot_used[_best] := true;
        _unit_team[_unit] := _slot_bin[_best];
        _bin_totals[_slot_bin[_best]] := _bin_totals[_slot_bin[_best]] + _unit_elos[_unit];
    END LOOP;

    FOR _unit IN 1.._unit_count LOOP
        IF _unit_team[_unit] > 0 THEN
            _selected_keys := array_append(_selected_keys, _unit_keys[_unit]);
            _selected_teams := array_append(_selected_teams, _unit_team[_unit]);
        END IF;
    END LOOP;

    -- Everyone in a unit that was passed over waits, together. created_at is
    -- untouched, so a later pass still honours the order they signed up in and
    -- the party is still one unit when it does.
    UPDATE public.tournament_free_agents fa
       SET status = 'waitlisted',
           tournament_team_id = NULL
     WHERE fa.id = ANY(_pool_ids)
       AND COALESCE(fa.party_id::text, 'solo:' || fa.id::text) <> ALL(_selected_keys);

    WITH placement AS (
        SELECT unnest(_selected_keys) AS unit_key,
               unnest(_selected_teams) AS team_index
    ),
    drafted AS (
        SELECT fa.player_steam_id,
               p.team_index,
               COALESCE(public.get_tournament_player_elo(_tournament_id, fa.player_steam_id), 5000) AS elo
          FROM public.tournament_free_agents fa
          JOIN placement p
            ON p.unit_key = COALESCE(fa.party_id::text, 'solo:' || fa.id::text)
         WHERE fa.id = ANY(_pool_ids)
    )
    SELECT array_agg(d.player_steam_id ORDER BY d.team_index, d.elo DESC, d.player_steam_id),
           array_agg(d.team_index      ORDER BY d.team_index, d.elo DESC, d.player_steam_id)
      INTO _steam_ids, _team_indexes
      FROM drafted d;

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
