-- Per-tournament trophy toggle. Lets organizers skip / clear trophies
-- on test or casual tournaments without affecting prior awards elsewhere.
ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS trophies_enabled boolean NOT NULL DEFAULT true;

-- Drop the denormalized copies. Tournament metadata is read via the
-- existing `tournament` relation; visuals come from tournament_trophy_configs
-- through a new manual relationship on (tournament_id, placement).
ALTER TABLE public.tournament_trophies
    DROP COLUMN IF EXISTS tournament_name,
    DROP COLUMN IF EXISTS tournament_start,
    DROP COLUMN IF EXISTS tournament_type,
    DROP COLUMN IF EXISTS custom_name,
    DROP COLUMN IF EXISTS silhouette,
    DROP COLUMN IF EXISTS image_url;

-- Flag rows awarded outside the standard bracket calc (manual imports).
ALTER TABLE public.tournament_trophies
    ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;

-- Tournament trophies can now be awarded to either a player or a real team.
-- Team trophies are only created for tournament_teams rows that point at
-- public.teams via tournament_teams.team_id.
ALTER TABLE public.tournament_trophies
    ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE;

ALTER TABLE public.tournament_trophies
    ALTER COLUMN player_steam_id DROP NOT NULL;

ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT IF EXISTS tournament_trophies_tournament_id_tournament_team_id_player_key;

ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT IF EXISTS tournament_trophies_tournament_team_player_placement_key;

DROP INDEX IF EXISTS public.tournament_trophies_tournament_team_player_placement_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.tournament_trophies'::regclass
          AND conname = 'tournament_trophies_one_recipient_check'
    ) THEN
        ALTER TABLE public.tournament_trophies
            ADD CONSTRAINT tournament_trophies_one_recipient_check
            CHECK (
                (CASE WHEN player_steam_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN team_id IS NULL THEN 0 ELSE 1 END) = 1
            );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.tournament_trophies'::regclass
          AND conname = 'tournament_trophies_mvp_requires_player_check'
    ) THEN
        ALTER TABLE public.tournament_trophies
            ADD CONSTRAINT tournament_trophies_mvp_requires_player_check
            CHECK (placement <> 0 OR player_steam_id IS NOT NULL);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_trophies_player_recipient_key
    ON public.tournament_trophies(tournament_id, tournament_team_id, player_steam_id, placement)
    WHERE player_steam_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_trophies_team_recipient_key
    ON public.tournament_trophies(tournament_id, tournament_team_id, team_id, placement)
    WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tournament_trophies_team
    ON public.tournament_trophies(team_id, placement)
    WHERE team_id IS NOT NULL;

-- Visuals are no longer copied onto tournament_trophies rows, so the
-- live-sync triggers on tournament_trophy_configs are dead weight.
DROP TRIGGER IF EXISTS tau_tournament_trophy_configs ON public.tournament_trophy_configs;
DROP TRIGGER IF EXISTS tad_tournament_trophy_configs ON public.tournament_trophy_configs;
DROP FUNCTION IF EXISTS public.tau_tournament_trophy_configs();
DROP FUNCTION IF EXISTS public.tad_tournament_trophy_configs();
