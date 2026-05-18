CREATE OR REPLACE FUNCTION public.is_team_assist(player_assist public.player_assists)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT player_assist.attacker_team = player_assist.attacked_team;
$$;
