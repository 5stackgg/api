ALTER TABLE public.direct_messages
    ADD COLUMN IF NOT EXISTS edited_at timestamptz;
