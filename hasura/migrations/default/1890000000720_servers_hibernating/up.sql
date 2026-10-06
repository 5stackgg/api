ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS hibernating boolean NOT NULL DEFAULT false;
