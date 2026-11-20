-- Acceptation des conditions d'utilisation et de la politique de confidentialite : quand et quelle version.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version text;
