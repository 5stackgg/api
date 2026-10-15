-- Holds the key clip and lineup file links are signed with, for the computed
-- fields that build them. Deliberately not tracked in the Hasura metadata, so
-- no role can read it; the api writes it at boot (FileUrlSigningService).
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.file_url_signing_key (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    key bytea NOT NULL
);
