CREATE OR REPLACE FUNCTION public.enforce_max_damage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.damage > 100 THEN
        NEW.damage = 100;
    END IF;
    RETURN NEW;
END;
$$;