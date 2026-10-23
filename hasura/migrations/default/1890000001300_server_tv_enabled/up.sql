ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS tv_enabled boolean NOT NULL DEFAULT false;
