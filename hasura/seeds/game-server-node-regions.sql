total_count = SELECT COUNT(*) FROM server_regions;

if total_count = 0 THEN
    INSERT INTO server_regions ("value", "description", "is_lan") VALUES
        ('USEast', 'US - East', false),
        ('USCentral', 'US - Central', false),
        ('USWest', 'US - West', false),
        ('SouthAmerica', 'South America', false),
        ('Europe', 'Europe', false),
        ('Asia', 'Asia', false),
        ('Australia', 'Australia', false),
        ('MiddleEast', 'Middle East', false),
        ('Africa', 'Africa', false),
        ('Lan', 'Lan', true);
END IF;