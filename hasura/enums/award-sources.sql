SET check_function_bodies = false;

insert into e_award_sources ("value", "description") values
    ('tournament', 'Calculated from a tournament placement'),
    ('manual', 'Granted by hand'),
    ('season', 'Calculated from a season standing')
on conflict(value) do update set "description" = EXCLUDED."description"
