-- Restores the shape timescale_init left behind: the primary key widened to
-- include the partitioning column, then the hypertable itself.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_schema = 'public' AND hypertable_name = 'player_sanctions'
    ) THEN
        RAISE NOTICE 'player_sanctions is already a hypertable, skipping';
        RETURN;
    END IF;

    ALTER TABLE public.player_sanctions
        DROP CONSTRAINT IF EXISTS player_sanctions_pkey;

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_pkey PRIMARY KEY (id, created_at);

    PERFORM create_hypertable('player_sanctions', 'created_at', migrate_data => true);
END;
$$;
