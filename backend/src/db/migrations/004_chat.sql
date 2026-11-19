-- Messagerie d'equipe : salons ouverts a toute l'organisation et messages directs entre deux membres.
CREATE TABLE chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('channel', 'dm')),
  name text,                -- salons uniquement
  topic text,
  dm_key text,              -- messages directs : "<uuid>:<uuid>" trie, pour qu'un couple n'ait qu'une conversation
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'channel' AND name IS NOT NULL AND dm_key IS NULL) OR (kind = 'dm' AND dm_key IS NOT NULL AND name IS NULL))
);
CREATE UNIQUE INDEX chat_channel_name_uq ON chat_channels(org_id, name) WHERE kind = 'channel';
CREATE UNIQUE INDEX chat_dm_uq ON chat_channels(org_id, dm_key) WHERE kind = 'dm';

CREATE TABLE chat_members (
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id bigint NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members(user_id);

CREATE TABLE chat_messages (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);
CREATE INDEX chat_messages_channel_idx ON chat_messages(channel_id, id DESC);
