CREATE INDEX IF NOT EXISTS idx_tournament_organizers_tournament_id
  ON public.tournament_organizers (tournament_id);

CREATE INDEX IF NOT EXISTS idx_tournament_stages_tournament_id
  ON public.tournament_stages (tournament_id);
