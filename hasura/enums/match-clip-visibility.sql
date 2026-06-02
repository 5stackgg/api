insert into e_match_clip_visibility ("value", "description") values
    ('public', 'Listed in the highlights feed'),
    ('private', 'Only visible to the owner'),
    ('match', 'Visible to match participants and organizers')
on conflict(value) do update set "description" = EXCLUDED."description"
