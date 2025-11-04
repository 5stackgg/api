update players set role = 'administrator' where role = 'system_administrator';

delete from e_player_roles where value = 'system_administrator';
