CREATE OR REPLACE FUNCTION public.tai_match_veto_picks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM create_match_map_from_veto(NEW);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_veto_picks ON public.match_veto_picks;
CREATE TRIGGER tai_match_veto_picks AFTER INSERT ON public.match_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tai_match_veto_picks();


CREATE OR REPLACE FUNCTION public.tai_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM add_owner_to_team(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_teams ON public.teams;
CREATE TRIGGER tai_teams AFTER INSERT ON public.teams FOR EACH ROW EXECUTE FUNCTION public.tai_teams();

CREATE OR REPLACE FUNCTION public.taiu_tournament_stages() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_tournament_stages(NEW.tournament_id);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiu_tournament_stages ON public.tournament_stages;
CREATE TRIGGER taiu_tournament_stages AFTER INSERT OR UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.taiu_tournament_stages();

CREATE OR REPLACE FUNCTION public.taiud_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM check_team_eligibility(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiud_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER taiud AFTER INSERT OR UPDATE OR DELETE ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.taiud_tournament_team_roster();


CREATE OR REPLACE FUNCTION public.tau_matches() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_tournament_bracket(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_matches ON public.matches;
CREATE TRIGGER tau_matches AFTER UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tau_matches();

CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN

    IF (tournament.status IS DISTINCT FROM OLD.status AND tournament.status != 'Live') THEN
        PERFORM seed_tournament(NEW);
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournaments ON public.tournaments;
CREATE TRIGGER tau_tournaments AFTER UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tau_tournaments();


CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
     IF NEW.tournament_team_id_1 IS NOT NULL AND NEW.tournament_team_id_2I IS NOT NULL AND NEW.match_id IS NULL THEN
         PERFORM schedule_tournament_match(NEW);
     END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournament_brackets ON public.tournament_brackets;
CREATE TRIGGER tau_tournament_brackets AFTER UPDATE ON public.tournament_brackets FOR EACH ROW EXECUTE FUNCTION public.tau_tournament_brackets();

CREATE OR REPLACE FUNCTION public.tau_match_maps() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_match_state(NEW);

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_maps ON public.match_maps;
CREATE TRIGGER tau_match_maps AFTER UPDATE ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.tau_match_maps();






DROP TRIGGER IF EXISTS tbd_remove_match_map ON public.match_veto_picks;
CREATE TRIGGER tbd_remove_match_map BEFORE DELETE ON public.match_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tbd_remove_match_map();

DROP TRIGGER IF EXISTS tbi_match ON public.matches;
CREATE TRIGGER tbi_match BEFORE INSERT ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbi_match();

DROP TRIGGER IF EXISTS tbi_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbi_match_lineup_players BEFORE INSERT ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.check_match_lineup_players_count();

DROP TRIGGER IF EXISTS tbiu_can_pick_veto ON public.match_veto_picks;
CREATE TRIGGER tbiu_can_pick_veto BEFORE INSERT OR UPDATE ON public.match_veto_picks FOR EACH ROW EXECUTE FUNCTION public.can_pick_veto();

DROP TRIGGER IF EXISTS tbiu_check_match_map_count ON public.match_maps;
CREATE TRIGGER tbiu_check_match_map_count BEFORE INSERT OR UPDATE ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.tbiu_check_match_map_count();

DROP TRIGGER IF EXISTS tbiu_encrypt_rcon ON public.servers;
CREATE TRIGGER tbiu_encrypt_rcon BEFORE INSERT OR UPDATE ON public.servers FOR EACH ROW EXECUTE FUNCTION public.tbiu_encrypt_rcon();

DROP TRIGGER IF EXISTS tbiu_enforce_max_damage_trigger ON public.player_damages;
CREATE TRIGGER tbiu_enforce_max_damage_trigger BEFORE INSERT OR UPDATE ON public.player_damages FOR EACH ROW EXECUTE FUNCTION public.enforce_max_damage();

DROP TRIGGER IF EXISTS tbiu_team_invite ON public.team_invites;
CREATE TRIGGER tbiu_team_invite BEFORE INSERT OR UPDATE ON public.team_invites FOR EACH ROW EXECUTE FUNCTION public.team_invite_check_for_existing_member();

DROP TRIGGER IF EXISTS tbiu_update_total_damage_trigger ON public.player_damages;
CREATE TRIGGER tbiu_update_total_damage_trigger BEFORE INSERT OR UPDATE ON public.player_damages FOR EACH ROW EXECUTE FUNCTION public.update_total_damage();

DROP TRIGGER IF EXISTS tbu_match_player_count ON public.matches;
CREATE TRIGGER tbu_match_player_count BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbu_match_player_count();

DROP TRIGGER IF EXISTS tbu_match_status ON public.matches;
CREATE TRIGGER tbu_match_status BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbu_match_status();

DROP TRIGGER IF EXISTS tbui_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbui_match_lineup_players BEFORE INSERT OR UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbui_match_lineup_players();

DROP TRIGGER IF EXISTS ti_v_pool_maps ON public.v_pool_maps;
CREATE TRIGGER ti_v_pool_maps INSTEAD OF INSERT ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.insert_into_v_map_pools();
