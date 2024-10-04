CREATE OR REPLACE VIEW public.v_match_lineups AS
 SELECT ml.id,
    ml.team_id,
    ml.coach_steam_id,
    m.id AS match_id
   FROM (public.match_lineups ml
     JOIN public.matches m ON (((m.lineup_1_id = ml.id) OR (m.lineup_2_id = ml.id))));