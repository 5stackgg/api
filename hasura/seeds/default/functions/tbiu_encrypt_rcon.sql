CREATE OR REPLACE FUNCTION public.tbiu_encrypt_rcon() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, current_setting('fivestack.app_key'));
    RETURN NEW;
END;
$$;