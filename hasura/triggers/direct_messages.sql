-- Whatever deletes a direct message -- its author, the retention sweep, its
-- author's account going -- its files are due. The sweep removes them from
-- storage before it forgets the row.
CREATE OR REPLACE FUNCTION public.tad_direct_messages() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.chat_attachments a
       SET expires_at = now()
      FROM deleted d
     WHERE a.message_id = d.id
       AND a.room_type = 'direct'
       AND (a.expires_at IS NULL OR a.expires_at > now());

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tad_direct_messages ON public.direct_messages;
CREATE TRIGGER tad_direct_messages
    AFTER DELETE ON public.direct_messages
    REFERENCING OLD TABLE AS deleted
    FOR EACH STATEMENT EXECUTE FUNCTION public.tad_direct_messages();
