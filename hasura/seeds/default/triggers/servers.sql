CREATE OR REPLACE FUNCTION public.tbiu_servers() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    enc_secret text;
BEGIN
    enc_secret = current_setting('fivestack.app_key');

    IF TG_OP = 'UPDATE' THEN
        IF NEW.rcon_password != pgp_sym_decrypt_bytea(OLD.rcon_password, enc_secret) THEN
           NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, enc_secret);
        ELSE
        raise notice 'old';
            NEW.rcon_password := OLD.rcon_password;
        END IF;
    ELSE
        NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, enc_secret);
    END IF;

	RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tbiu_servers ON public.servers;
CREATE TRIGGER tbiu_servers BEFORE INSERT OR UPDATE ON public.servers FOR EACH ROW EXECUTE FUNCTION public.tbiu_servers();