DROP TRIGGER IF EXISTS taiu_system_alert_activations ON public.system_alerts;
DROP FUNCTION IF EXISTS public.taiu_system_alert_activations();

DROP TABLE IF EXISTS public.system_alert_activations;

-- The boot loader skips a file whose digest is unchanged, so a forward deploy
-- after this rollback would bring the table back without its trigger.
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE replace(name, chr(92), '/') IN (
      'hasura/functions/system_alerts/taiu_system_alert_activations',
      'hasura/triggers/system_alerts'
    );
  END IF;
END $$;
