CREATE OR REPLACE FUNCTION public.is_team_damage(player_damage public.player_damages)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT player_damage.attacker_team = player_damage.attacked_team;
$$;
