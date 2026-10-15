ALTER TABLE public.tournament_mvp_picks
    DROP CONSTRAINT IF EXISTS tournament_mvp_picks_note_length_check;

ALTER TABLE public.tournament_mvp_picks
    DROP COLUMN IF EXISTS kept_automatic;
