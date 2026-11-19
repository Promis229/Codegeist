CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ======================= Identite & securite =======================
CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  forge_cloud_id text UNIQUE,
  ticket_seq int NOT NULL DEFAULT 0,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text,
  display_name text NOT NULL,
  avatar_url text,
  locale text NOT NULL DEFAULT 'fr',
  email_verified boolean NOT NULL DEFAULT false,
  totp_secret_enc text,
  totp_enabled boolean NOT NULL DEFAULT false,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  disabled boolean NOT NULL DEFAULT false,
  atlassian_account_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','agent','viewer')),
  skills text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE oauth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google','github')),
  provider_user_id text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_family_idx ON refresh_tokens(family_id);
CREATE INDEX refresh_user_idx ON refresh_tokens(user_id);

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz
);

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{read}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('android','ios','web')),
  push_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, push_token)
);

-- Journal d'audit infalsifiable (chaine de hachage)
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid,
  actor text,
  action text NOT NULL,
  entity text,
  entity_id text,
  data jsonb NOT NULL DEFAULT '{}',
  prev_hash text,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_idx ON audit_log(org_id, id);

-- ======================= Domaine support =======================
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email citext NOT NULL,
  name text NOT NULL,
  company text,
  tier text NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard','premium','enterprise')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seq int NOT NULL,
  key text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  channel text NOT NULL DEFAULT 'portal',
  lang text NOT NULL DEFAULT 'fr',
  tags text[] NOT NULL DEFAULT '{}',
  component text,
  sentiment real NOT NULL DEFAULT 0,
  frustration real NOT NULL DEFAULT 0,
  minhash int[] NOT NULL DEFAULT '{}',
  jira_issue_key text,
  reopened_count int NOT NULL DEFAULT 0,
  pii_redacted boolean NOT NULL DEFAULT false,
  first_response_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,''))
  ) STORED,
  UNIQUE (org_id, seq)
);
CREATE TRIGGER tickets_updated BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX tickets_org_status_idx ON tickets(org_id, status, created_at DESC);
CREATE INDEX tickets_search_idx ON tickets USING gin(search);
CREATE INDEX tickets_title_trgm ON tickets USING gin(title gin_trgm_ops);
CREATE INDEX tickets_customer_idx ON tickets(customer_id);

CREATE TABLE ticket_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_is_customer boolean NOT NULL DEFAULT false,
  internal boolean NOT NULL DEFAULT false,
  body text NOT NULL,
  sentiment real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_ticket_idx ON ticket_comments(ticket_id, created_at);

CREATE TABLE ticket_events (
  id bigserial PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type text NOT NULL,
  actor text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_ticket_idx ON ticket_events(ticket_id, id);

CREATE TABLE kb_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','confluence','generated')),
  source_id text,
  url text,
  space text,
  views int NOT NULL DEFAULT 0,
  helpful int NOT NULL DEFAULT 0,
  unhelpful int NOT NULL DEFAULT 0,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER kb_updated BEFORE UPDATE ON kb_articles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX kb_title_trgm ON kb_articles USING gin(title gin_trgm_ops);

CREATE TABLE ticket_kb_links (
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('suggested','cited','used')),
  score real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, article_id, relation)
);

CREATE TABLE sla_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('low','medium','high','critical')),
  first_response_mins int NOT NULL,
  resolve_mins int NOT NULL,
  UNIQUE (org_id, priority)
);

CREATE TABLE deploys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  version text,
  component text,
  deployed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 100,
  condition jsonb NOT NULL,
  actions jsonb NOT NULL,
  hits int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_enc text NOT NULL,
  events text[] NOT NULL DEFAULT '{*}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','dead')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_due_idx ON webhook_deliveries(status, next_attempt_at);

-- Coffre PII : valeurs reelles chiffrees, jetons reversibles pour les admins
CREATE TABLE pii_vault (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  token text NOT NULL,
  PRIMARY KEY (org_id, token),
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  kind text NOT NULL,
  value_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE answer_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  confidence real NOT NULL,
  citations jsonb NOT NULL,
  accepted boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);
