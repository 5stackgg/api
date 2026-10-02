ALTER TABLE public.game_plugins
    ADD COLUMN IF NOT EXISTS workshop_addons text[] NOT NULL DEFAULT '{}';
