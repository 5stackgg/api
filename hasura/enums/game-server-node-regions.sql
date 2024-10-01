INSERT INTO e_server_regions ("value", "description") VALUES
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
