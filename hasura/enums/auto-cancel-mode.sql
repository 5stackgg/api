insert into e_auto_cancel_mode ("value", "description") values
    ('AutoCancel', 'Auto cancel (default behavior)'),
    ('Admin', 'Admin-only cancel'),
    ('AutoNoCancel', 'Auto flow without cancel timer')
on conflict(value) do update set "description" = EXCLUDED."description"
