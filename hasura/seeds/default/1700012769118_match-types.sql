SET check_function_bodies = false;

insert into e_match_types ("value", "description") values
    ('Competitive', '5 vs 5 match using active map pool'),
    ('Scrimmage', '5 vs 5 match using all available map pools'),
    ('Wingman', '2 vs 2 match'),
    ('Custom', 'Custom match')
on conflict(value) do update set "description" = EXCLUDED."description"
