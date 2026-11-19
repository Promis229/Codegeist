-- Suivi du modele d'IA en production : chaque prediction servie est journalisee, puis comparee a la decision finale des agents.
CREATE TABLE ml_predictions (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  task text NOT NULL CHECK (task IN ('priority', 'component')),
  predicted text NOT NULL,
  confidence real NOT NULL,
  model_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ml_predictions_org_idx ON ml_predictions(org_id, task, created_at DESC);
CREATE INDEX ml_predictions_ticket_idx ON ml_predictions(ticket_id) WHERE ticket_id IS NOT NULL;
