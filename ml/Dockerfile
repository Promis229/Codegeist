# Kairos Brain : service d'IA (inférence). CPU uniquement.
#   docker build -t kairos-brain ./ml
#   docker run -p 8100:8100 -e KAIROS_ML_API_KEY=<secret> -v $(pwd)/ml/models:/app/models kairos-brain
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/opt/hf KAIROS_MODELS_DIR=/app/models
WORKDIR /app

# PyTorch CPU d'abord (évite ~2,5 Go de bibliothèques CUDA), puis le reste.
COPY requirements.txt ./
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install -r requirements.txt

# Le modèle de plongement est téléchargé UNE fois, au build, puis le service tourne sans accès réseau sortant.
ARG BAKE_EMBED_MODEL=1
ARG KAIROS_EMBED_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
ENV KAIROS_EMBED_MODEL=${KAIROS_EMBED_MODEL}
RUN if [ "$BAKE_EMBED_MODEL" = "1" ]; then python -c "from sentence_transformers import SentenceTransformer as S; S('${KAIROS_EMBED_MODEL}')"; fi

COPY kairos_brain ./kairos_brain
# Modèle entraîné embarqué dans l'image (un volume monté sur /app/models, comme dans docker-compose, le remplace).
COPY models ./models
RUN useradd -r -u 10001 kairos && mkdir -p /app/models && chown -R kairos /app /opt/hf
USER kairos

EXPOSE 8100
HEALTHCHECK --interval=20s --timeout=4s --start-period=40s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=3).status==200 else 1)"
CMD ["python", "-m", "kairos_brain", "serve", "--port", "8100"]
