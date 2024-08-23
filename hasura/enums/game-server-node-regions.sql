SET check_function_bodies = false;

INSERT INTO e_game_server_node_regions ("value", "description") VALUES
    ('USEast', 'US - East'),
    ('USCentral', 'US - Central'),
    ('USWest', 'US - West'),
    ('SouthAmerica', 'South America'),
    ('Europe', 'Europe'),
    ('Asia', 'Asia'),
    ('Australia', 'Australia'),
    ('MiddleEast', 'Middle East'),
    ('Africa', 'Africa'),
    ('Lan', 'Lan')
ON CONFLICT("value") DO UPDATE
    SET "description" = EXCLUDED."description";
