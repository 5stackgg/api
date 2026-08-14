-- One-off sweep of the alerts that accumulated before they were retracted on
-- resume/finish/cancel (see NotificationsService.resolveMatchAlerts).
--
-- "Map is paused" and "waiting for a server" describe a condition, so any of
-- them still outstanding against a match that has since stopped is describing
-- nothing. Live matches are deliberately left alone -- their alerts may still
-- be true.
UPDATE public.notifications n
   SET deleted_at = now()
  FROM public.matches m
 WHERE n.type = 'MatchStatusChange'
   AND n.deleted_at IS NULL
   AND m.id::text = n.entity_id
   AND m.status IN ('Canceled', 'Finished', 'Forfeit', 'Tie', 'Surrendered');

-- Alerts whose match no longer exists at all can never be resolved by an event,
-- so they would otherwise sit in the bell forever.
UPDATE public.notifications n
   SET deleted_at = now()
 WHERE n.type = 'MatchStatusChange'
   AND n.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.matches m WHERE m.id::text = n.entity_id
   );
