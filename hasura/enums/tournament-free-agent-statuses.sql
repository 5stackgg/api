insert into e_tournament_free_agent_statuses ("value", "description") values
    ('registered', 'Signed up and waiting for the draft'),
    ('drafted', 'Placed on a drafted team'),
    ('waitlisted', 'Did not make the cut; first in line if a slot opens'),
    ('withdrawn', 'Left the free agent pool')
on conflict(value) do update set "description" = EXCLUDED."description"
