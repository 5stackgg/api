-- Projects scheduled_eta for every bracket of a Live tournament: first from
-- each bracket's feeders, walking stage, round and match_number order (a feeder
-- that comes later in that order is read at its starting value), then by
-- queueing the unfinished brackets onto the tournament's servers.
--
-- This runs on most bracket and match changes, so it works in memory: one
-- query loads the brackets and their feeder links into arrays, and one UPDATE
-- writes back only the ETAs that changed. A temp table here would be recreated
-- on every call, and every statement touching it re-planned with it.
CREATE OR REPLACE FUNCTION calculate_tournament_bracket_start_times(_tournament_id uuid) RETURNS void AS $$
DECLARE
    tournament_status text;
    base_start_time timestamptz;
    -- One slot per bracket, in processing order.
    bracket_ids uuid[];
    eta_seeds timestamptz[];
    etas timestamptz[];
    durations interval[];
    stage_orders int[];
    rounds int[];
    match_numbers int[];
    live_matches boolean[];
    finished_brackets boolean[];
    -- (target, feeder) slot pairs, sorted by target.
    feeder_targets int[];
    feeder_slots int[];
    feeder_count int;
    feeder_index int := 1;
    feeder_ready timestamptz;
    server_capacity int;
    region_capacity int;
    server_free timestamptz[];
    min_index int;
    min_value timestamptz;
    slot int;
    i int;
BEGIN
    SELECT status, start
    INTO tournament_status, base_start_time
    FROM tournaments
    WHERE id = _tournament_id;

    IF tournament_status != 'Live' THEN
        RETURN;
    END IF;

    IF base_start_time IS NULL THEN
        base_start_time := NOW();
    END IF;
    -- A Live tournament should never project unscheduled rounds from a future
    -- start baseline; clamp to now when start is ahead.
    base_start_time := LEAST(base_start_time, NOW());

    WITH brackets AS (
        SELECT
            tb.id,
            tb.tournament_stage_id,
            ts."order" AS stage_order,
            tb.round,
            tb.match_number,
            tb.path,
            tb."group",
            tb.finished,
            CASE
                WHEN ts.type::text = 'Swiss' THEN
                    CASE
                        WHEN ((tb."group" / 100)::int) = 2 THEN 'advancement'
                        WHEN ((tb."group" % 100)::int) = 2 THEN 'elimination'
                        ELSE 'regular'
                    END
                ELSE COALESCE(tb.path, 'WB')
            END AS best_of_key,
            CASE
                WHEN m.status = 'Live' AND m.started_at IS NOT NULL THEN m.started_at
                WHEN m.status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
                     AND m.started_at IS NOT NULL THEN m.started_at
                WHEN m.scheduled_at IS NOT NULL THEN m.scheduled_at
                WHEN tb.scheduled_at IS NOT NULL THEN tb.scheduled_at
                ELSE NULL
            END AS eta_seed,
            COALESCE(m.status = 'Live', false) AS has_live_match
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        LEFT JOIN matches m ON m.id = tb.match_id
        WHERE ts.tournament_id = _tournament_id
    ),
    -- Once per stage, path and round rather than once per bracket.
    best_of AS (
        SELECT
            k.tournament_stage_id,
            k.best_of_key,
            k.round,
            COALESCE(get_bracket_best_of(k.tournament_stage_id, k.best_of_key, k.round), 1) AS best_of
        FROM (SELECT DISTINCT tournament_stage_id, best_of_key, round FROM brackets) k
    ),
    -- Brackets tied on round and match_number go winners bracket first, then
    -- by group and id, so the walk never depends on the order rows come back in.
    work AS (
        SELECT
            b.*,
            bo.best_of,
            row_number() OVER (
                ORDER BY b.stage_order, b.tournament_stage_id, b.round, b.match_number,
                         COALESCE(b.path, 'WB') DESC, b."group", b.id
            )::int AS slot
        FROM brackets b
        INNER JOIN best_of bo
            ON bo.tournament_stage_id = b.tournament_stage_id
           AND bo.best_of_key = b.best_of_key
           AND bo.round = b.round
    )
    SELECT
        array_agg(w.id ORDER BY w.slot),
        array_agg(w.eta_seed ORDER BY w.slot),
        array_agg(COALESCE(w.eta_seed, base_start_time) ORDER BY w.slot),
        array_agg(make_interval(mins => w.best_of * 60 + 15) ORDER BY w.slot),
        array_agg(w.stage_order ORDER BY w.slot),
        array_agg(w.round ORDER BY w.slot),
        array_agg(w.match_number ORDER BY w.slot),
        array_agg(w.has_live_match ORDER BY w.slot),
        array_agg(w.finished ORDER BY w.slot)
    INTO bracket_ids, eta_seeds, etas, durations, stage_orders, rounds,
         match_numbers, live_matches, finished_brackets
    FROM work w;

    IF bracket_ids IS NULL THEN
        RETURN;
    END IF;

    -- Round robin and Swiss brackets wait on the stage's previous round (Swiss
    -- only within the same group and path); elimination brackets wait on the
    -- brackets that send their winner or loser into them. Joined on the table
    -- itself so the planner can use its indexes, then mapped to slots.
    SELECT
        array_agg(p.target ORDER BY p.target, p.feeder),
        array_agg(p.feeder ORDER BY p.target, p.feeder)
    INTO feeder_targets, feeder_slots
    FROM (
        SELECT
            array_position(bracket_ids, target.id) AS target,
            array_position(bracket_ids, feeder.id) AS feeder
        FROM tournament_brackets target
        INNER JOIN tournament_stages ts ON ts.id = target.tournament_stage_id
        INNER JOIN tournament_brackets feeder
            ON feeder.tournament_stage_id = target.tournament_stage_id
           AND feeder.round = target.round - 1
        WHERE ts.tournament_id = _tournament_id
          AND ts.type::text IN ('RoundRobin', 'Swiss')
          AND (
            ts.type::text != 'Swiss'
            OR (
                COALESCE(feeder."group", -1) = COALESCE(target."group", -1)
                AND COALESCE(feeder.path, 'WB') = COALESCE(target.path, 'WB')
            )
          )
        UNION ALL
        SELECT
            array_position(bracket_ids, target.id),
            array_position(bracket_ids, feeder.id)
        FROM tournament_brackets target
        INNER JOIN tournament_stages ts ON ts.id = target.tournament_stage_id
        INNER JOIN tournament_brackets feeder
            ON feeder.parent_bracket_id = target.id
            OR feeder.loser_parent_bracket_id = target.id
        WHERE ts.tournament_id = _tournament_id
          AND ts.type::text NOT IN ('RoundRobin', 'Swiss')
    ) p
    WHERE p.feeder IS NOT NULL;

    feeder_count := COALESCE(cardinality(feeder_targets), 0);

    FOR slot IN 1..cardinality(bracket_ids) LOOP
        feeder_ready := NULL;
        WHILE feeder_index <= feeder_count AND feeder_targets[feeder_index] = slot LOOP
            i := feeder_slots[feeder_index];
            feeder_ready := GREATEST(feeder_ready, etas[i] + durations[i]);
            feeder_index := feeder_index + 1;
        END LOOP;

        IF eta_seeds[slot] IS NULL THEN
            etas[slot] := COALESCE(feeder_ready, base_start_time);
        END IF;
    END LOOP;

    WITH resolved_match_options AS (
        SELECT DISTINCT COALESCE(tb.match_options_id, ts.match_options_id, t.match_options_id) AS match_options_id
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN tournaments t ON t.id = ts.tournament_id
        WHERE t.id = _tournament_id
    ),
    tournament_regions AS (
        SELECT DISTINCT unnest(mo.regions) AS region
        FROM resolved_match_options rmo
        INNER JOIN match_options mo ON mo.id = rmo.match_options_id
        WHERE mo.regions IS NOT NULL
          AND cardinality(mo.regions) > 0
    )
    SELECT COALESCE(SUM(total_region_server_count(sr)), 0)::int
    INTO region_capacity
    FROM tournament_regions tr
    INNER JOIN server_regions sr ON sr.value = tr.region;

    server_capacity := GREATEST(COALESCE(region_capacity, 0), 1);
    server_free := array_fill(NOW(), ARRAY[server_capacity]);

    -- Live matches hold their servers first.
    FOR slot IN
        SELECT q.slot
        FROM unnest(etas, stage_orders, rounds, match_numbers, live_matches, finished_brackets)
             WITH ORDINALITY AS q(eta, stage_order, round, match_number, live, finished, slot)
        WHERE q.live AND NOT q.finished
        ORDER BY q.eta, q.stage_order, q.round, q.match_number, q.slot
    LOOP
        min_index := 1;
        min_value := server_free[1];

        FOR i IN 2..server_capacity LOOP
            IF server_free[i] < min_value THEN
                min_index := i;
                min_value := server_free[i];
            END IF;
        END LOOP;

        server_free[min_index] := GREATEST(
            server_free[min_index],
            COALESCE(etas[slot], NOW())
        ) + durations[slot];
    END LOOP;

    -- Everything else unfinished queues behind them in ETA order.
    FOR slot IN
        SELECT q.slot
        FROM unnest(etas, stage_orders, rounds, match_numbers, live_matches, finished_brackets)
             WITH ORDINALITY AS q(eta, stage_order, round, match_number, live, finished, slot)
        WHERE NOT q.live AND NOT q.finished
        ORDER BY q.eta, q.stage_order, q.round, q.match_number, q.slot
    LOOP
        min_index := 1;
        min_value := server_free[1];

        FOR i IN 2..server_capacity LOOP
            IF server_free[i] < min_value THEN
                min_index := i;
                min_value := server_free[i];
            END IF;
        END LOOP;

        etas[slot] := GREATEST(
            COALESCE(etas[slot], base_start_time),
            server_free[min_index]
        );
        server_free[min_index] := etas[slot] + durations[slot];
    END LOOP;

    UPDATE tournament_brackets tb
    SET scheduled_eta = u.eta
    FROM unnest(bracket_ids, etas) AS u(id, eta)
    WHERE tb.id = u.id
      AND tb.scheduled_eta IS DISTINCT FROM u.eta;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION tournament_bracket_eta(bracket tournament_brackets) returns timestamptz as $$
DECLARE
    bracket_start_time timestamptz;
BEGIN
    IF bracket.scheduled_eta IS NOT NULL THEN
        RETURN bracket.scheduled_eta;
    END IF;
    
    RETURN (
        SELECT t.start 
        FROM tournaments t
        INNER JOIN tournament_stages ts ON ts.id = bracket.tournament_stage_id
        WHERE ts.id = bracket.tournament_stage_id
    );
END;
$$ language plpgsql STABLE;