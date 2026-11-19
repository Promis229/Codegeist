"""Kairos Brain : modèles d'IA de Kairos (entraînement et inférence), indépendants du backend.

    from kairos_brain import data, train, service

Un modèle de plongement multilingue (français, anglais, espagnol) sert de socle ; des modèles légers entraînés sur VOS
demandes (priorité, composant, délai de résolution, risque de réouverture) s'appuient dessus. Aucune donnée ne quitte
votre infrastructure : le service tourne chez vous et le backend lui envoie des textes déjà masqués (PII).
"""

__version__ = "1.0.0"
