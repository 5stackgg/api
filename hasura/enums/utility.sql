insert into e_utility_visibility ("value", "description") values
    ('Private', 'Only the author'),
    ('Team', 'The author and their team'),
    ('Public', 'Anyone')
on conflict(value) do update set "description" = EXCLUDED."description";

-- Movement and stance at release. Crouch composes with the others because a
-- crouched jump throw is a different lineup from a standing one.
insert into e_utility_techniques ("value", "description") values
    ('Stationary', 'Standing still'),
    ('Walking', 'Holding walk'),
    ('Running', 'Running'),
    ('Crouch', 'Crouched, standing still'),
    ('Jump', 'Jump throw from standstill'),
    ('RunJump', 'Running jump throw'),
    ('WalkJump', 'Walking jump throw'),
    ('CrouchJump', 'Crouched jump throw')
on conflict(value) do update set "description" = EXCLUDED."description";

-- CS2 has exactly three release strengths.
insert into e_utility_throw_strengths ("value", "description") values
    ('Full', 'Left click'),
    ('Half', 'Left and right click together'),
    ('Drop', 'Right click')
on conflict(value) do update set "description" = EXCLUDED."description";

insert into e_utility_sources ("value", "description") values
    ('plugin', 'Recorded in game by the utility practice plugin'),
    ('demo', 'Derived from a parsed match demo'),
    ('editor', 'Placed by hand in the web editor'),
    ('import', 'Imported from an external source'),
    ('fork', 'Copied from another lineup in the library')
on conflict(value) do update set "description" = EXCLUDED."description";

-- Starting/Ready are the two statuses the one-live-session-per-host index
-- covers; everything else is terminal.
insert into e_utility_practice_statuses ("value", "description") values
    ('Starting', 'Waiting on a server'),
    ('Ready', 'Server is up and joinable'),
    ('Ended', 'Stopped normally'),
    ('Failed', 'Never came up')
on conflict(value) do update set "description" = EXCLUDED."description";
