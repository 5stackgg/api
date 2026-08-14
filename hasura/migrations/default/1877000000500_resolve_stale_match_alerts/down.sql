-- One-way: the sweep cannot distinguish rows it retracted from rows retracted
-- by the application, and un-deleting both would resurrect the backlog.
SELECT 1;
