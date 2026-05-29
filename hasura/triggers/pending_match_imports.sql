CREATE OR REPLACE FUNCTION public.tbu_pending_match_imports()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tbu_pending_match_imports ON public.pending_match_imports;
CREATE OR REPLACE TRIGGER tbu_pending_match_imports
    BEFORE UPDATE ON public.pending_match_imports
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_pending_match_imports();
