total_count = SELECT COUNT(*) FROM server_regions;

if total_count = 0 THEN
    INSERT INTO server_regions ("value", "description", "is_lan") VALUES
        ('US East', 'US - East', false),
        ('US Central', 'US - Central', false),
        ('US West', 'US - West', false),
        ('South America', 'South America', false),
        ('Europe', 'Europe', false),
        ('Asia', 'Asia', false),
        ('Australia', 'Australia', false),
        ('Middle East', 'Middle East', false),
        ('Africa', 'Africa', false),
        ('Lan', 'Lan', true);
END IF;