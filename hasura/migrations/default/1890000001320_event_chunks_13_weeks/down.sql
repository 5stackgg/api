DO $$
DECLARE
    _table text;
BEGIN
    FOREACH _table IN ARRAY ARRAY[
        'player_assists', 'player_damages', 'player_flashes',
        'player_kills', 'player_objectives', 'player_utility'
    ] LOOP
        PERFORM set_chunk_time_interval(_table::regclass, interval '7 days');
    END LOOP;
END $$;
