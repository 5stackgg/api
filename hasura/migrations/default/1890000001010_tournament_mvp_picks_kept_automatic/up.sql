-- Its own migration, not an edit to 1890000001000: a database that already
-- ran that one never runs it again.
ALTER TABLE public.tournament_mvp_picks
    ADD COLUMN IF NOT EXISTS kept_automatic boolean NOT NULL DEFAULT false;

ALTER TABLE public.tournament_mvp_picks
    DROP CONSTRAINT IF EXISTS tournament_mvp_picks_note_check;
ALTER TABLE public.tournament_mvp_picks
    DROP CONSTRAINT IF EXISTS tournament_mvp_picks_note_length_check;
ALTER TABLE public.tournament_mvp_picks
    ADD CONSTRAINT tournament_mvp_picks_note_length_check
    CHECK (note IS NULL OR char_length(note) <= 140);
