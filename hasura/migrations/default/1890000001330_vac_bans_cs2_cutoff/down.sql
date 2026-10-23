-- A lifted auto-ban comes back on its own: the next Steam check under the old
-- cutoff re-activates it.
ALTER TABLE public.players
  DROP COLUMN IF EXISTS last_vac_ban_at;
