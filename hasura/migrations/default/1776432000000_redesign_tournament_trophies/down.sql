ALTER TABLE public.tournament_trophies
    DROP COLUMN IF EXISTS manual,
    ADD COLUMN tournament_name text,
    ADD COLUMN tournament_start timestamptz,
    ADD COLUMN tournament_type text,
    ADD COLUMN custom_name text,
    ADD COLUMN silhouette int CHECK (silhouette IS NULL OR (silhouette >= 0 AND silhouette <= 4)),
    ADD COLUMN image_url text;

ALTER TABLE public.tournaments DROP COLUMN IF EXISTS trophies_enabled;

CREATE OR REPLACE FUNCTION public.tau_tournament_trophy_configs() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.tournament_trophies
        SET custom_name = NEW.custom_name,
            silhouette  = NEW.silhouette,
            image_url   = NEW.image_url
      WHERE tournament_id = NEW.tournament_id
        AND placement = NEW.placement;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournament_trophy_configs ON public.tournament_trophy_configs;
CREATE TRIGGER tau_tournament_trophy_configs
    AFTER INSERT OR UPDATE ON public.tournament_trophy_configs
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_tournament_trophy_configs();

CREATE OR REPLACE FUNCTION public.tad_tournament_trophy_configs() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.tournament_trophies
        SET custom_name = NULL,
            silhouette  = NULL,
            image_url   = NULL
      WHERE tournament_id = OLD.tournament_id
        AND placement = OLD.placement;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_tournament_trophy_configs ON public.tournament_trophy_configs;
CREATE TRIGGER tad_tournament_trophy_configs
    AFTER DELETE ON public.tournament_trophy_configs
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_tournament_trophy_configs();
