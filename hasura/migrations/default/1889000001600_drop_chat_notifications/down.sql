-- The rows are gone for good: chat pushes straight from the conversation.
CREATE INDEX IF NOT EXISTS notifications_message_id_idx
    ON public.notifications ((data->>'messageId'))
    WHERE data->>'messageId' IS NOT NULL;
