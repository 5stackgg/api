CREATE TABLE IF NOT EXISTS public.e_auto_cancel_mode (
    value text NOT NULL PRIMARY KEY,
    description text
);

INSERT INTO public.e_auto_cancel_mode (value, description) VALUES
    ('AutoCancel', 'Auto cancel (default behavior)'),
    ('Admin', 'Admin-only cancel'),
    ('AutoNoCancel', 'Auto flow without cancel timer')
ON CONFLICT DO NOTHING;
