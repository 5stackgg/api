CREATE OR REPLACE FUNCTION calculate_tournament_bracket_start_times(_tournament_id uuid) RETURNS void AS $$
DECLARE
    tournament_status text;
    base_start_time timestamptz;
    bracket_record RECORD;
    stage_record RECORD;
    queue_record RECORD;
    feeder_ready timestamptz;
    server_capacity int;
    region_capacity int;
    server_free timestamptz[];
    min_index int;
    min_value timestamptz;
    duration_interval interval;
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

    UPDATE tournament_brackets
    SET scheduled_eta = NULL
    WHERE tournament_stage_id IN (
        SELECT id FROM tournament_stages WHERE tournament_id = _tournament_id
    );
    CREATE TEMP TABLE IF NOT EXISTS eta_work (
        id uuid PRIMARY KEY,
        tournament_stage_id uuid NOT NULL,
        stage_order int NOT NULL,
        stage_type text NOT NULL,
        round int NOT NULL,
        match_number int NOT NULL,
        path text,
        bracket_group int,
        parent_bracket_id uuid,
        loser_parent_bracket_id uuid,
        bracket_scheduled_at timestamptz,
        bracket_finished boolean NOT NULL,
        best_of int NOT NULL,
        duration_minutes int NOT NULL,
        eta_seed timestamptz,
        has_live_match boolean NOT NULL,
        computed_eta timestamptz
    ) ON COMMIT DROP;

    TRUNCATE eta_work;

    INSERT INTO eta_work (
        id,
        tournament_stage_id,
        stage_order,
        stage_type,
        round,
        match_number,
        path,
        bracket_group,
        parent_bracket_id,
        loser_parent_bracket_id,
        bracket_scheduled_at,
        bracket_finished,
        best_of,
        duration_minutes,
        eta_seed,
        has_live_match,
        computed_eta
    )
    SELECT
        tb.id,
        tb.tournament_stage_id,
        ts."order",
        ts.type::text,
        tb.round,
        tb.match_number,
        tb.path,
        tb."group",
        tb.parent_bracket_id,
        tb.loser_parent_bracket_id,
        tb.scheduled_at,
        tb.finished,
        COALESCE(
            get_bracket_best_of(
                ts.id,
                CASE
                    WHEN ts.type::text = 'Swiss' THEN
                        CASE
                            WHEN ((tb."group" / 100)::int) = 2 THEN 'advancement'
                            WHEN ((tb."group" % 100)::int) = 2 THEN 'elimination'
                            ELSE 'regular'
                        END
                    ELSE COALESCE(tb.path, 'WB')
                END,
                tb.round
            ),
            1
        ) AS best_of,
        (COALESCE(
            get_bracket_best_of(
                ts.id,
                CASE
                    WHEN ts.type::text = 'Swiss' THEN
                        CASE
                            WHEN ((tb."group" / 100)::int) = 2 THEN 'advancement'
                            WHEN ((tb."group" % 100)::int) = 2 THEN 'elimination'
                            ELSE 'regular'
                        END
                    ELSE COALESCE(tb.path, 'WB')
                END,
                tb.round
            ),
            1
        ) * 60) + 15 AS duration_minutes,
        CASE
            WHEN m.status = 'Live' AND m.started_at IS NOT NULL THEN m.started_at
            WHEN m.status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
                 AND m.started_at IS NOT NULL THEN m.started_at
            WHEN m.scheduled_at IS NOT NULL THEN m.scheduled_at
            WHEN tb.scheduled_at IS NOT NULL THEN tb.scheduled_at
            ELSE NULL
        END AS eta_seed,
        COALESCE(m.status = 'Live', false) AS has_live_match,
        NULL::timestamptz
    FROM tournament_brackets tb
    INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    LEFT JOIN matches m ON m.id = tb.match_id
    WHERE ts.tournament_id = _tournament_id;

    UPDATE eta_work
    SET computed_eta = COALESCE(eta_seed, base_start_time);

    FOR stage_record IN
        SELECT DISTINCT stage_order, tournament_stage_id, stage_type
        FROM eta_work
        ORDER BY stage_order
    LOOP
        FOR bracket_record IN
            SELECT *
            FROM eta_work
            WHERE tournament_stage_id = stage_record.tournament_stage_id
            ORDER BY round ASC, match_number ASC
        LOOP
            IF bracket_record.eta_seed IS NOT NULL THEN
                CONTINUE;
            END IF;

            IF stage_record.stage_type IN ('RoundRobin', 'Swiss') THEN
                SELECT MAX(ew.computed_eta + make_interval(mins => ew.duration_minutes))
                INTO feeder_ready
                FROM eta_work ew
                WHERE ew.tournament_stage_id = bracket_record.tournament_stage_id
                  AND ew.round = bracket_record.round - 1
                  AND (
                    stage_record.stage_type != 'Swiss'
                    OR COALESCE(ew.bracket_group, -1) = COALESCE(bracket_record.bracket_group, -1)
                  )
                  AND (
                    stage_record.stage_type != 'Swiss'
                    OR COALESCE(ew.path, 'WB') = COALESCE(bracket_record.path, 'WB')
                  );
            ELSE
                SELECT MAX(ew.computed_eta + make_interval(mins => ew.duration_minutes))
                INTO feeder_ready
                FROM eta_work ew
                WHERE ew.parent_bracket_id = bracket_record.id
                   OR ew.loser_parent_bracket_id = bracket_record.id;
            END IF;

            feeder_ready := COALESCE(feeder_ready, base_start_time);

            IF bracket_record.bracket_scheduled_at IS NOT NULL THEN
                feeder_ready := GREATEST(feeder_ready, bracket_record.bracket_scheduled_at);
            END IF;

            UPDATE eta_work
            SET computed_eta = feeder_ready
            WHERE id = bracket_record.id;

        END LOOP;
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
    server_free := ARRAY[]::timestamptz[];

    FOR i IN 1..server_capacity LOOP
        server_free := array_append(server_free, NOW());
    END LOOP;

    FOR queue_record IN
        SELECT *
        FROM eta_work
        WHERE has_live_match = true
          AND bracket_finished = false
        ORDER BY computed_eta ASC, stage_order ASC, round ASC, match_number ASC
    LOOP
        min_index := 1;
        min_value := server_free[1];

        FOR i IN 2..array_length(server_free, 1) LOOP
            IF server_free[i] < min_value THEN
                min_index := i;
                min_value := server_free[i];
            END IF;
        END LOOP;

        duration_interval := make_interval(mins => queue_record.duration_minutes);
        server_free[min_index] := GREATEST(
            server_free[min_index],
            COALESCE(queue_record.computed_eta, NOW())
        ) + duration_interval;
    END LOOP;

    FOR queue_record IN
        SELECT *
        FROM eta_work
        WHERE has_live_match = false
          AND bracket_finished = false
        ORDER BY computed_eta ASC, stage_order ASC, round ASC, match_number ASC
    LOOP
        min_index := 1;
        min_value := server_free[1];

        FOR i IN 2..array_length(server_free, 1) LOOP
            IF server_free[i] < min_value THEN
                min_index := i;
                min_value := server_free[i];
            END IF;
        END LOOP;

        duration_interval := make_interval(mins => queue_record.duration_minutes);

        UPDATE eta_work
        SET computed_eta = GREATEST(
            COALESCE(queue_record.computed_eta, base_start_time),
            server_free[min_index]
        )
        WHERE id = queue_record.id
        RETURNING computed_eta INTO min_value;

        server_free[min_index] := min_value + duration_interval;
    END LOOP;

    UPDATE tournament_brackets tb
    SET scheduled_eta = ew.computed_eta
    FROM eta_work ew
    WHERE ew.id = tb.id;

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