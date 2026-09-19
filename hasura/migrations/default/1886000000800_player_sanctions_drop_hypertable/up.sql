-- player_sanctions was converted to a hypertable in timescale_init alongside
-- the six genuine per-event stats tables, but nothing queries it by time:
-- is_muted, is_gagged, is_banned, banned_until, is_admin_sanctioned and
-- sanction_policy all filter on player_steam_id alone. With no predicate on
-- the partitioning column chunk exclusion can never prune anything, so every
-- one of those lookups fans a sequential scan across every chunk instead of
-- using idx_player_sanctions_steam_type -- and a chunk is added every
-- interval, so the cost per call grows without bound. Nothing claims the other
-- side of that trade: there is no retention policy, no compression, and no
-- query anywhere that filters by created_at range.
--
-- Partitioning also cost the table its primary key. TimescaleDB requires the
-- partitioning column in every unique index, so timescale_init had to widen
-- the original PRIMARY KEY (id) to (id, created_at), which left the uuid that
-- identifies a sanction without a uniqueness guarantee. Converting back
-- restores it.
DO $$
DECLARE
    trigger_definitions text[];
    trigger_definition text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_schema = 'public' AND hypertable_name = 'player_sanctions'
    ) THEN
        RAISE NOTICE 'player_sanctions is already a plain table, skipping';
        RETURN;
    END IF;

    -- Hasura creates its event triggers directly on the table rather than in
    -- metadata this migration could replay, and the swap below drops them with
    -- the old table. Capture them first and recreate them at the end so event
    -- delivery is not silently lost until the next metadata apply.
    SELECT coalesce(array_agg(pg_get_triggerdef(oid)), '{}')
      INTO trigger_definitions
      FROM pg_trigger
     WHERE tgrelid = 'public.player_sanctions'::regclass
       AND NOT tgisinternal;

    CREATE TABLE public.player_sanctions_plain (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        player_steam_id bigint NOT NULL,
        type text NOT NULL,
        reason text,
        remove_sanction_date timestamptz,
        sanctioned_by_steam_id bigint,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
    );

    INSERT INTO public.player_sanctions_plain (
        id, player_steam_id, type, reason, remove_sanction_date,
        sanctioned_by_steam_id, created_at, deleted_at
    )
    SELECT id, player_steam_id, type, reason, remove_sanction_date,
           sanctioned_by_steam_id, created_at, deleted_at
    FROM public.player_sanctions;

    DROP TABLE public.player_sanctions;
    ALTER TABLE public.player_sanctions_plain RENAME TO player_sanctions;

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_pkey PRIMARY KEY (id);

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_player_steam_id_fkey
        FOREIGN KEY (player_steam_id) REFERENCES public.players(steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE;

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_sanctioned_by_steam_id_fkey
        FOREIGN KEY (sanctioned_by_steam_id) REFERENCES public.players(steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL;

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_type_fkey
        FOREIGN KEY (type) REFERENCES public.e_sanction_types(value)
        ON UPDATE CASCADE ON DELETE RESTRICT;

    CREATE INDEX idx_player_sanctions_steam_type
        ON public.player_sanctions (player_steam_id, type);

    CREATE INDEX idx_player_sanctions_one_auto_ban
        ON public.player_sanctions (player_steam_id)
        WHERE type = 'ban' AND sanctioned_by_steam_id IS NULL;

    -- TimescaleDB created this one implicitly for the partitioning column.
    -- Kept because the moderation screens still order sanctions by recency.
    CREATE INDEX player_sanctions_created_at_idx
        ON public.player_sanctions (created_at DESC);

    FOREACH trigger_definition IN ARRAY trigger_definitions LOOP
        EXECUTE trigger_definition;
    END LOOP;
END;
$$;
