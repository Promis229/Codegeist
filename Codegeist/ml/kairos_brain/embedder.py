"""Plongement de textes multilingue avec cache mémoire (par empreinte du texte)."""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from threading import Lock

import numpy as np

from .config import CACHE_SIZE, EMBED_MODEL


class HashingEmbedder:
    """Plongement de TEST (n-grammes de caractères hachés, 384 dimensions). Sert uniquement aux tests automatiques et au
    démarrage sans réseau : il ne comprend pas le sens, donc aucune recherche multilingue. Jamais utilisé par défaut."""

    model_name = "hashing-test-only"
    dim = 384

    def __init__(self):
        from sklearn.feature_extraction.text import HashingVectorizer

        self._v = HashingVectorizer(n_features=self.dim, analyzer="char_wb", ngram_range=(3, 5), alternate_sign=False, norm="l2", lowercase=True)

    def encode(self, texts: list[str], batch_size: int = 32) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        return self._v.transform(texts).toarray().astype(np.float32)

    @property
    def cache_size(self) -> int:
        return 0


def make_embedder():
    """Embedder réel par défaut ; KAIROS_EMBEDDER=hash force le plongement de test (tests, CI sans réseau)."""
    import os

    return HashingEmbedder() if os.environ.get("KAIROS_EMBEDDER") == "hash" else Embedder()


class Embedder:
    def __init__(self, model_name: str = EMBED_MODEL, device: str | None = None):
        from sentence_transformers import SentenceTransformer  # import tardif : le service démarre vite sans lui

        self.model_name = model_name
        self.model = SentenceTransformer(model_name, device=device)
        self.dim = int(self.model.get_sentence_embedding_dimension())
        self._cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self._lock = Lock()

    @staticmethod
    def _key(text: str) -> str:
        return hashlib.sha1(text.encode("utf-8")).hexdigest()

    def encode(self, texts: list[str], batch_size: int = 32) -> np.ndarray:
        """Vecteurs L2-normalisés (produit scalaire = cosinus). Les textes déjà vus ne sont pas recalculés."""
        keys = [self._key(t) for t in texts]
        out: list[np.ndarray | None] = [None] * len(texts)
        todo: list[int] = []
        with self._lock:
            for i, k in enumerate(keys):
                hit = self._cache.get(k)
                if hit is not None:
                    self._cache.move_to_end(k)
                    out[i] = hit
                else:
                    todo.append(i)
        if todo:
            vecs = self.model.encode([texts[i] for i in todo], batch_size=batch_size, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
            with self._lock:
                for i, v in zip(todo, vecs):
                    v = v.astype(np.float32)
                    out[i] = v
                    self._cache[keys[i]] = v
                while len(self._cache) > CACHE_SIZE:
                    self._cache.popitem(last=False)
        return np.stack(out) if out else np.zeros((0, self.dim), dtype=np.float32)

    @property
    def cache_size(self) -> int:
        return len(self._cache)
