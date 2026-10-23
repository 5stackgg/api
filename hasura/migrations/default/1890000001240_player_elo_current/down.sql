DROP TRIGGER IF EXISTS tai_player_elo_current ON public.player_elo;
DROP TRIGGER IF EXISTS tau_player_elo_current ON public.player_elo;
DROP TRIGGER IF EXISTS tad_player_elo_current ON public.player_elo;
DROP TRIGGER IF EXISTS tat_player_elo_current ON public.player_elo;
DROP TRIGGER IF EXISTS tau_matches_player_elo_current ON public.matches;
DROP FUNCTION IF EXISTS public.taiudt_player_elo_current();
DROP FUNCTION IF EXISTS public.tau_matches_player_elo_current();
DROP FUNCTION IF EXISTS public.refresh_player_elo_current(bigint[]);
DROP TABLE IF EXISTS public.player_elo_current;
