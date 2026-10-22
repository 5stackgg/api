DROP TRIGGER IF EXISTS tbiu_player_elo_is_tournament ON public.player_elo;
DROP TRIGGER IF EXISTS taiud_tournament_brackets_player_elo ON public.tournament_brackets;
DROP FUNCTION IF EXISTS public.tbiu_player_elo_is_tournament();
DROP FUNCTION IF EXISTS public.taiud_tournament_brackets_player_elo();
DROP INDEX IF EXISTS public.idx_player_elo_tournament;
ALTER TABLE public.player_elo DROP COLUMN IF EXISTS is_tournament;
