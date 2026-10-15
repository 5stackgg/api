-- Rush has no veto, so its scouting switch is gone from the web.
DELETE FROM public.settings
 WHERE name = 'public.veto_scouting_rush';
