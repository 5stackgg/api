DROP INDEX IF EXISTS public.idx_tournament_free_agents_party;

ALTER TABLE public.tournament_free_agents
    DROP COLUMN IF EXISTS party_id;
