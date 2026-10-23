-- The event tables are read by match or map, never by time, so every read
-- probes each chunk's index: weekly chunks made a match page cost more every
-- week (25k pages a poll at two years of history against 9k at 13 weeks).
-- Chunks become 13 weeks, and an install's existing weekly chunks are merged
-- into their quarter. merge_chunks only joins adjacent chunks, so a week with
-- no events splits its quarter in two; a TimescaleDB too old to have it keeps
-- its weekly chunks and only new ones are 13 weeks.
DO $$
DECLARE
    _table text;
    _chunks regclass[];
BEGIN
    FOREACH _table IN ARRAY ARRAY[
        'player_assists', 'player_damages', 'player_flashes',
        'player_kills', 'player_objectives', 'player_utility'
    ] LOOP
        PERFORM set_chunk_time_interval(_table::regclass, interval '13 weeks');

        CONTINUE WHEN to_regprocedure('merge_chunks(regclass[])') IS NULL;

        FOR _chunks IN
            WITH chunk AS (
                SELECT format('%I.%I', chunk_schema, chunk_name)::regclass AS id,
                       range_start,
                       range_end,
                       time_bucket(interval '13 weeks', range_start, timestamptz '1970-01-01 00:00:00+00') AS quarter
                FROM timescaledb_information.chunks
                WHERE hypertable_schema = 'public' AND hypertable_name = _table
            ),
            run_start AS (
                SELECT *,
                       CASE WHEN lag(range_end) OVER (PARTITION BY quarter ORDER BY range_start) = range_start
                            THEN 0 ELSE 1 END AS starts_run
                FROM chunk
            ),
            run AS (
                SELECT *, sum(starts_run) OVER (PARTITION BY quarter ORDER BY range_start) AS run
                FROM run_start
            )
            SELECT array_agg(id ORDER BY range_start)
            FROM run
            GROUP BY quarter, run
            HAVING count(*) > 1
        LOOP
            CALL merge_chunks(_chunks);
        END LOOP;
    END LOOP;
END $$;
