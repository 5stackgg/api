SET check_function_bodies = false;

insert into e_league_proposal_statuses ("value", "description") values
    ('Pending', 'Pending response'),
    ('Accepted', 'Accepted'),
    ('Declined', 'Declined'),
    ('Countered', 'Countered with a new time'),
    ('Superseded', 'Superseded by another proposal'),
    ('Expired', 'Expired')
on conflict(value) do update set "description" = EXCLUDED."description"
