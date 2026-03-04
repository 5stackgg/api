ALTER TABLE public.match_options
    ADD COLUMN auto_cancel boolean NOT NULL DEFAULT true;

-- Migrate existing data
UPDATE public.match_options
SET auto_cancel = CASE
    WHEN auto_cancel_mode = 'AutoNoCancel' THEN false
    ELSE true
END;

-- Drop old column and enum table
ALTER TABLE public.match_options DROP COLUMN auto_cancel_mode;
DROP TABLE IF EXISTS public.e_auto_cancel_mode;
