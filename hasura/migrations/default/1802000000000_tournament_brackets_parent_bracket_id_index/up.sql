CREATE INDEX IF NOT EXISTS idx_tournament_brackets_parent_bracket_id
  ON public.tournament_brackets (parent_bracket_id);
