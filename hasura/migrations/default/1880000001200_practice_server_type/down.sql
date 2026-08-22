UPDATE public.servers SET "type" = 'Custom' WHERE "type" = 'Practice';
DELETE FROM public.e_server_types WHERE "value" = 'Practice';
