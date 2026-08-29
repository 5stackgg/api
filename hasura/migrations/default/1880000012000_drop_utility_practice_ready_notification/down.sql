INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('UtilityPracticeReady', 'Your utility practice server is ready')
ON CONFLICT("value") DO NOTHING;
