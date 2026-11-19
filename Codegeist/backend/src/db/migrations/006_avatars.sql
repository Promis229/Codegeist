-- Photos de profil téléversées (stockées dans PostgreSQL, redimensionnées côté navigateur avant l'envoi).
CREATE TABLE user_avatars (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime text NOT NULL,
  size integer NOT NULL,
  data bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
