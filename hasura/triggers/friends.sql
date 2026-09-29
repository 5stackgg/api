-- On the table rather than on v_my_friends: syncSteamFriends writes here
-- directly and never goes through the view.
CREATE OR REPLACE FUNCTION public.tbiu_friends() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.assert_not_blocked(NEW.player_steam_id, NEW.other_player_steam_id);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_friends ON public.friends;
CREATE TRIGGER tbiu_friends BEFORE INSERT OR UPDATE ON public.friends FOR EACH ROW EXECUTE FUNCTION public.tbiu_friends();
