CREATE OR REPLACE VIEW public.v_match_captains AS
 SELECT mlp.steam_id,
    mlp.match_lineup_id,
    mlp.discord_id,
    mlp.captain,
    mlp.placeholder_name,
    mlp.id
   FROM public.match_lineup_players mlp
  WHERE (mlp.captain = true);