CREATE FUNCTION public.is_team_damage(player_damage public.player_damages) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
      return   player_damage.attacker_team = player_damage.attacked_team;
END;
$$;