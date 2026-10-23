ALTER TABLE public.custom_pages ADD COLUMN IF NOT EXISTS nav_featured boolean NOT NULL DEFAULT false;
