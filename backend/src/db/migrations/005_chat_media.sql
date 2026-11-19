-- Messagerie : réponses à un message précis et pièces jointes (stockées dans PostgreSQL : rien d'autre à déployer).
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_body_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_body_check CHECK (length(body) <= 4000);
ALTER TABLE chat_messages ADD COLUMN reply_to bigint REFERENCES chat_messages(id) ON DELETE SET NULL;
CREATE INDEX chat_messages_reply_idx ON chat_messages(reply_to) WHERE reply_to IS NOT NULL;

CREATE TABLE chat_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id bigint NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mime text NOT NULL,
  size integer NOT NULL CHECK (size > 0),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_attachments_message_idx ON chat_attachments(message_id);
