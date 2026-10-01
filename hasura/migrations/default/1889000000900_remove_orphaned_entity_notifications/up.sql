-- tad_matches and tbd_tournaments now take a deleted match's or tournament's
-- notifications with it. This clears the ones left behind before they did,
-- which still link to a page that 404s. Invite rows are not swept: an invite is
-- also deleted when it is answered, so a missing one does not mean its
-- tournament is gone.
DELETE FROM public.notifications n
 WHERE n.type IN (
         'MatchStatusChange',
         'MatchImported',
         'MatchSupport',
         'MatchAbandoned',
         'MatchStatsReady',
         'AdminCall'
       )
   AND n.entity_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.matches m WHERE m.id::text = n.entity_id
   );

DELETE FROM public.notifications n
 WHERE n.type = 'MatchChatMessage'
   AND (n.entity_id LIKE 'match:%' OR n.entity_id LIKE 'match\_team:%' ESCAPE '\')
   AND NOT EXISTS (
     SELECT 1 FROM public.matches m
      WHERE m.id::text = split_part(n.entity_id, ':', 2)
   );

DELETE FROM public.notifications n
 WHERE n.type IN (
         'TournamentCreated',
         'TournamentCheckInOpen',
         'TournamentCheckInMissed',
         'TournamentPartySignup',
         'TournamentReminder',
         'TournamentCheckInClosing'
       )
   AND n.entity_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.tournaments t
      WHERE t.id::text = split_part(n.entity_id, ':', 1)
   );

DELETE FROM public.notifications n
 WHERE n.type = 'ChatMessage'
   AND n.entity_id LIKE 'tournament:%'
   AND NOT EXISTS (
     SELECT 1 FROM public.tournaments t
      WHERE t.id::text = split_part(n.entity_id, ':', 2)
   );
