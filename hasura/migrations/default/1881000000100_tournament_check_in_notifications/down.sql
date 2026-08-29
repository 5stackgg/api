DELETE FROM public.e_notification_types
 WHERE value IN ('TournamentCheckInOpen', 'TournamentCheckInClosing', 'TournamentCheckInMissed');
