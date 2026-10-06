ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
