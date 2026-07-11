-- "Organized by" reflects the organizer list; the creator is shown by default
-- but can be hidden from that display (they remain the owner for permissions).
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS hide_creator_organizer boolean NOT NULL DEFAULT false;
