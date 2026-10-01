insert into e_server_migration_statuses ("value", "description") values
    ('Queued', 'Waiting to start'),
    ('Stopping', 'Stopping the server on its current node'),
    ('Transferring', 'Copying the server files to the new node'),
    ('Finalizing', 'Switching the server to the new node'),
    ('Completed', 'Moved to the new node'),
    ('Failed', 'The move failed and the server was restored on its original node'),
    ('Canceled', 'The move was canceled and the server was restored on its original node')
on conflict(value) do update set "description" = EXCLUDED."description"
