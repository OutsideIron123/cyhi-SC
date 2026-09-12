# ---------------------------------------------------------------------------
# ZenLayer backend — CPU-only inference image.
# ---------------------------------------------------------------------------
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/models \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TORCH_THREADS=4 \
    OMP_NUM_THREADS=4 \
    MKL_NUM_THREADS=4 \
    PORT=8000

WORKDIR /app

# curl is only needed for the container HEALTHCHECK below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Dependencies are their own layer so code edits don't re-download torch.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Bake the weights into the image: the container then starts offline in seconds
# instead of pulling ~600MB from the Hub on first request.
RUN python -c "\
from transformers import pipeline; \
from sentence_transformers import SentenceTransformer; \
pipeline('text-classification', model='martin-ha/toxic-comment-model'); \
pipeline('image-classification', model='Falconsai/nsfw_image_detection'); \
SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')" \
 && chmod -R a+rX /opt/models

# Drop privileges — nothing here needs root at runtime.
RUN useradd --create-home --uid 10001 zenlayer
USER zenlayer

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["python", "app.py"]
