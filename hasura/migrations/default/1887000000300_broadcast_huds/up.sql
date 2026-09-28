CREATE TABLE IF NOT EXISTS public.broadcast_huds (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    slug text NOT NULL,
    jthud_id text NOT NULL,
    variant text,
    name text NOT NULL,
    author text,
    version text,
    description text,
    source text NOT NULL DEFAULT 'imported',
    enabled boolean NOT NULL DEFAULT true,
    storage_key text,
    size_bytes bigint,
    thumbnail text,
    preview text,
    page_url text,
    hud_json jsonb,
    is_signed boolean NOT NULL DEFAULT false,
    uploaded_by_steam_id bigint REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (id),
    UNIQUE (slug),

    CONSTRAINT broadcast_huds_slug_is_path_safe
        CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),

    CONSTRAINT broadcast_huds_jthud_id_is_path_safe
        CHECK (jthud_id ~ '^[A-Za-z0-9_-]+$'),

    CONSTRAINT broadcast_huds_source_is_known
        CHECK (source IN ('builtin', 'imported')),

    CONSTRAINT broadcast_huds_archive_matches_source
        CHECK (
            (source = 'builtin'  AND storage_key IS NULL)
         OR (source = 'imported' AND storage_key IS NOT NULL)
        )
);

ALTER TABLE public.broadcast_huds ADD COLUMN IF NOT EXISTS preview text;
ALTER TABLE public.broadcast_huds ADD COLUMN IF NOT EXISTS page_url text;

CREATE INDEX IF NOT EXISTS idx_broadcast_huds_enabled
    ON public.broadcast_huds (enabled);

INSERT INTO public.broadcast_huds
    (slug, jthud_id, variant, name, description, source)
VALUES
    ('default-horizontal', 'default', 'horizontal',
     'JTs Hud (Horizontal)',
     'The layout bundled with JTs Hud Manager, arranged horizontally.',
     'builtin'),
    ('default-vertical', 'default', 'vertical',
     'JTs Hud (Vertical)',
     'The layout bundled with JTs Hud Manager, arranged vertically.',
     'builtin')
ON CONFLICT (slug) DO NOTHING;
