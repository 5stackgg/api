UPDATE public.tournaments SET status = 'RegistrationOpen' WHERE status = 'CheckInReview';

DELETE FROM public.e_tournament_status WHERE value = 'CheckInReview';
