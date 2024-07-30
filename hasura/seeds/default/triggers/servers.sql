CREATE OR REPLACE FUNCTION public.tbiu_servers() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, current_setting('fivestack.app_key'));
	RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tbiu_servers ON public.servers;
CREATE TRIGGER tbiu_servers BEFORE INSERT OR UPDATE ON public.servers FOR EACH ROW EXECUTE FUNCTION public.tbiu_servers();