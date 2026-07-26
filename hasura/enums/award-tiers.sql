SET check_function_bodies = false;

insert into e_award_tiers ("value", "description") values
    ('mvp', 'Most valuable player'),
    ('gold', 'First place'),
    ('silver', 'Second place'),
    ('bronze', 'Third place'),
    ('special', 'Standalone award')
on conflict(value) do update set "description" = EXCLUDED."description"
