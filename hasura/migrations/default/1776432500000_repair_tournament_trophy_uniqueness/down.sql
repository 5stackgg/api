-- Roll back to the original trophy uniqueness shape. MVP + placement cannot
-- coexist under that key, so keep placement rows ahead of MVP rows.

WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY tournament_id, tournament_team_id, player_steam_id
            ORDER BY (placement = 0) ASC, manual DESC, created_at ASC, id ASC
        ) AS row_number
    FROM public.tournament_trophies
)
DELETE FROM public.tournament_trophies trophy
USING ranked
WHERE trophy.id = ranked.id
  AND ranked.row_number > 1;

ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT IF EXISTS tournament_trophies_tournament_team_player_placement_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tournament_trophies'::regclass
          AND conname = 'tournament_trophies_tournament_id_tournament_team_id_player_key'
    ) THEN
        ALTER TABLE public.tournament_trophies
            ADD CONSTRAINT tournament_trophies_tournament_id_tournament_team_id_player_key
            UNIQUE (tournament_id, tournament_team_id, player_steam_id);
    END IF;
END;
$$;
