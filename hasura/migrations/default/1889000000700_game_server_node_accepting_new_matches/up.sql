ALTER TABLE public.game_server_nodes
    ADD COLUMN IF NOT EXISTS accepting_new_matches boolean NOT NULL DEFAULT true;

UPDATE public.game_server_nodes
   SET accepting_new_matches = false
 WHERE status = 'NotAcceptingNewMatches';
