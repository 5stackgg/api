CREATE OR REPLACE FUNCTION public.is_team_kill(player_kill public.player_kills)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN player_kill.attacker_team = player_kill.attacked_team;
END
$$;
