SET check_function_bodies = false;

insert into e_team_roles ("value", "description") values
    ('Pending', 'Invite Pending'),
    ('Member', 'Basic Membership'),
    ('Invite', 'Ability Invite / Add Players'),
    ('Admin', 'Administrator')
on conflict(value) do update set "description" = EXCLUDED."description"
