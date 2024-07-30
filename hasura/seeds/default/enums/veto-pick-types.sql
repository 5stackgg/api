SET check_function_bodies = false;

insert into e_veto_pick_types ("value", "description") values
    ('Ban', 'Ban'),
    ('Pick', 'Pick'),
    ('Side', 'Side'),
    ('Decider', 'Decider')
on conflict(value) do update set "description" = EXCLUDED."description"
