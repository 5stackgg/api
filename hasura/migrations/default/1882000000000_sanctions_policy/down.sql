INSERT INTO public.settings (name, value)
SELECT 'public.steam_ban_enforcement_enabled', s.value
  FROM public.settings s
 WHERE s.name = 'public.sanction_vac_ban_enabled'
ON CONFLICT (name) DO NOTHING;

DELETE FROM public.settings WHERE name LIKE 'public.sanction\_%';

DROP FUNCTION IF EXISTS public.player_sanction_expiry(bigint, text);
DROP FUNCTION IF EXISTS public.player_source_sanction_expiry(text, bigint);
DROP FUNCTION IF EXISTS public.record_tournament_no_shows(uuid);
DROP FUNCTION IF EXISTS public.sanction_remove_date(text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.sanction_expiry(text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.sanction_occurrences(text, bigint);
DROP FUNCTION IF EXISTS public.sanction_policy_covers(text, text);
DROP FUNCTION IF EXISTS public.sanction_policy_scope(text);
DROP FUNCTION IF EXISTS public.sanction_policy_durations(text);
DROP FUNCTION IF EXISTS public.sanction_policy_window_days(text);
DROP FUNCTION IF EXISTS public.sanction_policy_threshold(text);
DROP FUNCTION IF EXISTS public.sanction_policy_enabled(text);

DROP TABLE IF EXISTS public.tournament_no_shows;
DROP TABLE IF EXISTS public.e_sanction_sources;
DROP TABLE IF EXISTS public.e_sanction_scopes;

DROP INDEX IF EXISTS public.idx_abandoned_matches_steam_id;
