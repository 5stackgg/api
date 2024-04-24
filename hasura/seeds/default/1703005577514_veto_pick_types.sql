SET check_function_bodies = false;

insert into e_veto_pick_types ("value", "description") values
    ('Ban', 'Ban'),
    ('Pick', 'Pick'),
    ('Side', 'Side'),
    ('LeftOver', 'Left Over')
on conflict(value) do update set "description" = EXCLUDED."description"
