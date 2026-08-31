ALTER TABLE public.tournaments
    DROP COLUMN IF EXISTS check_in_closed_for,
    DROP COLUMN IF EXISTS check_in_closing_notified_for;
