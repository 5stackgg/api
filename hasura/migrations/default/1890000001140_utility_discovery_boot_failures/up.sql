-- How many servers booked for a queued discovery went away before it was
-- thrown. Kept on the row, not the queue job: one job serves every discovery
-- and its data is wiped each time it hands a server back.
ALTER TABLE public.utility_discoveries
    ADD COLUMN IF NOT EXISTS boot_failures integer NOT NULL DEFAULT 0;
