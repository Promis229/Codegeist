-- Versions multilingues de contenus d'amorce (messages d'equipe, sujets de salon, noms de regles) : {"fr": "...", "en": "...", "es": "..."}.
-- Les contenus saisis par les utilisateurs n'ont pas de version : la colonne reste NULL et le texte saisi est affiche tel quel.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS body_i18n jsonb;
ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS topic_i18n jsonb;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS name_i18n jsonb;
