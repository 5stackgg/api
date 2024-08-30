-- CREATE OR REPLACE FUNCTION public.tbu_tournament_options() RETURNS TRIGGER
--     LANGUAGE plpgsql
--     AS $$
-- BEGIN
--
--     IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'Live') THEN
--         PERFORM seed_tournament(NEW);
--     END IF;
--
-- 	RETURN NEW;
-- END;
-- $$;
--
-- DROP TRIGGER IF EXISTS tad_tournaments ON public.tournaments;
-- CREATE TRIGGER tad_tournaments AFTER DELETE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tad_tournaments();
