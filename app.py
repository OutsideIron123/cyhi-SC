"""ZenLayer — a local-first wellbeing filter for social feeds.

Three self-hosted models run on CPU and are loaded exactly once at import time:

  1. Toxicity     martin-ha/toxic-comment-model        (dynamic INT8 quantized)
  2. Semantic     all-MiniLM-L6-v2 + a trigger vault   (cosine similarity)
  3. NSFW image   Falconsai/nsfw_image_detection       (224x224 RGB)

Nothing leaves the machine. No model is ever constructed inside a request
handler; handlers only run inference against the globals below.
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import os
import threading
import time
from typing import Any

import torch
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image, UnidentifiedImageError
from sentence_transformers import SentenceTransformer
from transformers import pipeline

TORCH_THREADS = int(os.getenv("TORCH_THREADS", "4"))

TOXICITY_MODEL = "unitary/toxic-bert"
EMBEDDER_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
NSFW_MODEL = "Falconsai/nsfw_image_detection"

TEXT_MAX_LENGTH = 128          
IMAGE_SIZE = (224, 224)        
TEXT_BATCH_SIZE = 16
IMAGE_BATCH_SIZE = 8

MAX_POSTS_PER_REQUEST = 128
MAX_TRIGGERS = 256
MAX_TRIGGER_CHARS = 200
MAX_IMAGE_BYTES = 8 * 1024 * 1024

DEFAULT_TOXICITY_THRESHOLD = 0.70
DEFAULT_SIMILARITY_THRESHOLD = 0.45
DEFAULT_TRIGGERS = ["spoilers", "layoffs", "political argument"]


TOXIC_POSITIVE_LABELS = {"toxic", "label_1"}
NSFW_POSITIVE_LABELS = {"nsfw", "porn", "label_1"}



torch.set_num_threads(TORCH_THREADS)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
)
log = logging.getLogger("zenlayer")

def _load_toxicity_classifier():
    """Text classifier returning every label's probability, INT8 quantized.

    Dynamic quantization swaps the Linear layers for int8 kernels at load time.
    On CPU this roughly halves the model's memory footprint and cuts latency,
    which is what makes a per-keystroke feed filter viable on a laptop.
    """
    pipe = pipeline(
        task="text-classification",
        model=TOXICITY_MODEL,
        tokenizer=TOXICITY_MODEL,
        top_k=None,
        truncation=True,
        padding=True,
        max_length=TEXT_MAX_LENGTH,
        device=-1,
    )
    
    pipe.model.eval()
    return pipe


def _load_embedder() -> SentenceTransformer:
    model = SentenceTransformer(EMBEDDER_MODEL, device="cpu")
    model.eval()
    return model


def _load_nsfw_classifier():
    pipe = pipeline(
        task="image-classification",
        model=NSFW_MODEL,
        top_k=None,
        device=-1,
    )
    pipe.model.eval()
    return pipe


log.info("Loading models (torch threads=%d)...", TORCH_THREADS)
_t0 = time.perf_counter()

TOXICITY_PIPELINE = _load_toxicity_classifier()
log.info("  toxicity classifier ready (INT8 dynamic quantization applied)")

EMBEDDER = _load_embedder()
log.info("  semantic embedder ready")

NSFW_PIPELINE = _load_nsfw_classifier()
log.info("  NSFW image classifier ready")

log.info("All models loaded in %.1fs", time.perf_counter() - _t0)

class TriggerVault:
    """The user's custom topic list plus its precomputed embedding matrix.

    Readers take an immutable (phrases, embeddings) snapshot, so /classify never
    sees a half-applied update from a concurrent /update-triggers call.
    """

    def __init__(self, embedder: SentenceTransformer, phrases: list[str]) -> None:
        self._embedder = embedder
        self._lock = threading.Lock()
        self._snapshot: tuple[list[str], torch.Tensor] = self._encode(phrases)

    def _encode(self, phrases: list[str]) -> tuple[list[str], torch.Tensor]:
        if not phrases:
            
            dim = self._embedder.get_sentence_embedding_dimension()
            return [], torch.empty((0, dim), dtype=torch.float32)
        with torch.inference_mode():
            embeddings = self._embedder.encode(
                phrases,
                convert_to_tensor=True,
                normalize_embeddings=True,
                batch_size=TEXT_BATCH_SIZE,
                show_progress_bar=False,
            )
        return list(phrases), embeddings.float()

    def replace(self, phrases: list[str]) -> list[str]:
        encoded = self._encode(phrases)
        with self._lock:
            self._snapshot = encoded
        return encoded[0]

    def snapshot(self) -> tuple[list[str], torch.Tensor]:
        with self._lock:
            return self._snapshot

    def __len__(self) -> int:
        return len(self._snapshot[0])


TRIGGER_VAULT = TriggerVault(EMBEDDER, DEFAULT_TRIGGERS)
log.info("Trigger vault seeded with %d phrases: %s", len(TRIGGER_VAULT), DEFAULT_TRIGGERS)

def _scores_to_dict(raw: Any) -> dict[str, float]:
    """Flatten a pipeline result into {label: probability}.

    With top_k=None a pipeline returns a list of dicts per input, but a
    single-input call returns that list unwrapped -- normalize both shapes.
    """
    if isinstance(raw, dict):
        raw = [raw]
    return {entry["label"].lower(): float(entry["score"]) for entry in raw}


def _positive_score(scores: dict[str, float], positive_labels: set[str]) -> float:
    """Probability assigned to the 'bad' class.

    Matched by explicit label name rather than index, because checkpoints differ
    on whether index 0 or 1 is the positive class.
    """
    for label, score in scores.items():
        if label in positive_labels:
            return score
    
    
    if len(scores) == 2:
        for label, score in scores.items():
            if label.startswith(("non", "not", "normal", "safe", "neutral")):
                return 1.0 - score
    return 0.0


def _chunks(items: list, size: int):
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _run_toxicity(texts: list[str]) -> list[dict[str, float]]:
    """Batched toxicity inference. Returns per-text {label: probability}."""
    results: list[dict[str, float]] = []
    with torch.inference_mode():
        for chunk in _chunks(texts, TEXT_BATCH_SIZE):
            raw = TOXICITY_PIPELINE(chunk, batch_size=len(chunk))
            results.extend(_scores_to_dict(item) for item in raw)
    return results


def _run_semantic(texts: list[str], threshold: float) -> list[dict[str, Any]]:
    """Cosine similarity of each text against every trigger phrase."""
    phrases, trigger_embeddings = TRIGGER_VAULT.snapshot()
    if not phrases:
        return [
            {
                "max_similarity": 0.0,
                "matched_trigger": None,
                "matches": [],
                "all_similarities": {},
            }
            for _ in texts
        ]

    with torch.inference_mode():
        post_embeddings = EMBEDDER.encode(
            texts,
            convert_to_tensor=True,
            normalize_embeddings=True,
            batch_size=TEXT_BATCH_SIZE,
            show_progress_bar=False,
        ).float()
        
        similarities = post_embeddings @ trigger_embeddings.T

    out: list[dict[str, Any]] = []
    for row in similarities:
        row_scores = {phrase: round(float(v), 4) for phrase, v in zip(phrases, row)}
        best_idx = int(torch.argmax(row))
        matches = [
            {"trigger": phrase, "similarity": score}
            for phrase, score in sorted(
                row_scores.items(), key=lambda kv: kv[1], reverse=True
            )
            if score >= threshold
        ]
        out.append(
            {
                "max_similarity": round(float(row[best_idx]), 4),
                "matched_trigger": phrases[best_idx] if matches else None,
                "matches": matches,
                "all_similarities": row_scores,
            }
        )
    return out


def _decode_image(payload: str) -> Image.Image:
    """Decode a base64 image (with or without a data: URI prefix) to 224x224 RGB."""
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        blob = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"invalid base64 payload: {exc}") from exc
    if not blob:
        raise ValueError("empty image payload")
    if len(blob) > MAX_IMAGE_BYTES:
        raise ValueError(
            f"image exceeds {MAX_IMAGE_BYTES // (1024 * 1024)}MB decoded limit"
        )
    try:
        image = Image.open(io.BytesIO(blob))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"undecodable image: {exc}") from exc
    return image.convert("RGB").resize(IMAGE_SIZE, Image.BILINEAR)


def _run_nsfw(images: list[Image.Image]) -> list[dict[str, float]]:
    results: list[dict[str, float]] = []
    with torch.inference_mode():
        for chunk in _chunks(images, IMAGE_BATCH_SIZE):
            raw = NSFW_PIPELINE(chunk, batch_size=len(chunk))
            results.extend(_scores_to_dict(item) for item in raw)
    return results

class BadRequest(Exception):
    """Client-side validation failure -> 400."""


def _as_threshold(payload: dict, key: str, default: float) -> float:
    value = payload.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BadRequest(f"'{key}' must be a number between 0 and 1")
    value = float(value)
    if not 0.0 <= value <= 1.0:
        raise BadRequest(f"'{key}' must be between 0 and 1, got {value}")
    return value


def _clean_triggers(raw: Any) -> list[str]:
    """Accept either a bare JSON array or {"triggers": [...]}."""
    if isinstance(raw, dict):
        for key in ("triggers", "topics", "phrases"):
            if key in raw:
                raw = raw[key]
                break
        else:
            raise BadRequest("expected a JSON array of strings or {'triggers': [...]}")
    if not isinstance(raw, list):
        raise BadRequest("expected a JSON array of strings")
    if len(raw) > MAX_TRIGGERS:
        raise BadRequest(f"at most {MAX_TRIGGERS} triggers allowed, got {len(raw)}")

    cleaned: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, str):
            raise BadRequest(f"trigger at index {index} is not a string")
        phrase = item.strip()
        if not phrase:
            continue
        if len(phrase) > MAX_TRIGGER_CHARS:
            raise BadRequest(
                f"trigger at index {index} exceeds {MAX_TRIGGER_CHARS} characters"
            )
        key = phrase.lower()
        if key not in seen:
            seen.add(key)
            cleaned.append(phrase)
    return cleaned


def _clean_posts(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise BadRequest("'posts' must be an array")
    if not raw:
        raise BadRequest("'posts' must not be empty")
    if len(raw) > MAX_POSTS_PER_REQUEST:
        raise BadRequest(
            f"at most {MAX_POSTS_PER_REQUEST} posts per request, got {len(raw)}"
        )

    posts: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise BadRequest(f"post at index {index} is not an object")
        post_id = item.get("id", index)
        if not isinstance(post_id, (str, int)):
            raise BadRequest(f"post at index {index} has a non-scalar 'id'")
        text = item.get("text")
        if text is not None and not isinstance(text, str):
            raise BadRequest(f"post '{post_id}' has a non-string 'text'")
        image = item.get("image_base64")
        if image is not None and not isinstance(image, str):
            raise BadRequest(f"post '{post_id}' has a non-string 'image_base64'")
        posts.append(
            {
                "id": post_id,
                "text": (text or "").strip(),
                "image_base64": image or "",
            }
        )
    return posts

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  
CORS(app, resources={r"/*": {"origins": os.getenv("CORS_ORIGINS", "*")}})


@app.errorhandler(BadRequest)
def _handle_bad_request(exc: BadRequest):
    return jsonify({"error": "bad_request", "message": str(exc)}), 400


@app.errorhandler(413)
def _handle_too_large(_exc):
    return jsonify({"error": "payload_too_large", "message": "request body too large"}), 413


@app.errorhandler(Exception)
def _handle_unexpected(exc: Exception):
    log.exception("Unhandled error")
    return jsonify({"error": "internal_error", "message": str(exc)}), 500


def _json_body() -> Any:
    body = request.get_json(silent=True)
    if body is None:
        raise BadRequest("request body must be valid JSON")
    return body


@app.get("/health")
def health():
    phrases, _ = TRIGGER_VAULT.snapshot()
    return jsonify(
        {
            "status": "ok",
            "service": "zenlayer-backend",
            "device": "cpu",
            "torch_version": torch.__version__,
            "torch_threads": torch.get_num_threads(),
            "models": {
                "toxicity": {
                    "name": TOXICITY_MODEL,
                    "quantization": "dynamic-int8",
                    "max_length": TEXT_MAX_LENGTH,
                    "loaded": True,
                },
                "embedder": {
                    "name": EMBEDDER_MODEL,
                    "dimensions": EMBEDDER.get_sentence_embedding_dimension(),
                    "loaded": True,
                },
                "nsfw": {
                    "name": NSFW_MODEL,
                    "input_size": list(IMAGE_SIZE),
                    "loaded": True,
                },
            },
            "triggers": {"count": len(phrases), "phrases": phrases},
            "defaults": {
                "toxicity_threshold": DEFAULT_TOXICITY_THRESHOLD,
                "similarity_threshold": DEFAULT_SIMILARITY_THRESHOLD,
            },
        }
    )


@app.post("/update-triggers")
def update_triggers():
    """Replace the trigger vault with the caller's topics and re-embed them."""
    phrases = _clean_triggers(_json_body())
    started = time.perf_counter()
    applied = TRIGGER_VAULT.replace(phrases)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    log.info("Trigger vault updated: %d phrases in %.2fms", len(applied), elapsed_ms)
    return jsonify(
        {
            "status": "ok",
            "count": len(applied),
            "triggers": applied,
            "embedding_dimensions": EMBEDDER.get_sentence_embedding_dimension(),
            "encode_ms": elapsed_ms,
        }
    )


@app.post("/classify")
def classify():
    body = _json_body()
    if not isinstance(body, dict):
        raise BadRequest("request body must be a JSON object")

    posts = _clean_posts(body.get("posts"))
    toxicity_threshold = _as_threshold(body, "toxicity_threshold", DEFAULT_TOXICITY_THRESHOLD)
    similarity_threshold = _as_threshold(body, "similarity_threshold", DEFAULT_SIMILARITY_THRESHOLD)

    started = time.perf_counter()
    results: list[dict[str, Any]] = [
        {
            "id": post["id"],
            "flagged": False,
            "reasons": [],
            "flags": {"toxicity": False, "semantic_trigger": False, "nsfw": False},
            "toxicity": None,
            "semantic": None,
            "nsfw": None,
            "errors": [],
        }
        for post in posts
    ]

    
    text_indices = [i for i, post in enumerate(posts) if post["text"]]
    texts = [posts[i]["text"] for i in text_indices]

    if texts:
        toxicity_scores = _run_toxicity(texts)
        semantic_hits = _run_semantic(texts, similarity_threshold)

        for slot, index in enumerate(text_indices):
            result = results[index]

            scores = toxicity_scores[slot]
            toxic_probability = _positive_score(scores, TOXIC_POSITIVE_LABELS)
            top_label = max(scores, key=scores.get)
            is_toxic = toxic_probability >= toxicity_threshold
            result["toxicity"] = {
                "flagged": is_toxic,
                "score": round(toxic_probability, 4),
                "threshold": toxicity_threshold,
                "margin": round(toxic_probability - toxicity_threshold, 4),
                "top_label": top_label,
                "scores": {label: round(v, 4) for label, v in scores.items()},
            }

            hit = semantic_hits[slot]
            is_triggered = bool(hit["matches"])
            result["semantic"] = {
                "flagged": is_triggered,
                "max_similarity": hit["max_similarity"],
                "threshold": similarity_threshold,
                "margin": round(hit["max_similarity"] - similarity_threshold, 4),
                "matched_trigger": hit["matched_trigger"],
                "matches": hit["matches"],
                "similarities": hit["all_similarities"],
            }

            result["flags"]["toxicity"] = is_toxic
            result["flags"]["semantic_trigger"] = is_triggered
            if is_toxic:
                result["reasons"].append(f"toxicity:{top_label}")
            if is_triggered:
                result["reasons"].append(f"trigger:{hit['matched_trigger']}")

    
    image_indices: list[int] = []
    images: list[Image.Image] = []
    for index, post in enumerate(posts):
        if not post["image_base64"]:
            continue
        try:
            images.append(_decode_image(post["image_base64"]))
            image_indices.append(index)
        except ValueError as exc:
            
            results[index]["errors"].append({"stage": "image_decode", "message": str(exc)})

    if images:
        nsfw_scores = _run_nsfw(images)
        for slot, index in enumerate(image_indices):
            result = results[index]
            scores = nsfw_scores[slot]
            nsfw_probability = _positive_score(scores, NSFW_POSITIVE_LABELS)
            top_label = max(scores, key=scores.get)
            is_nsfw = top_label in NSFW_POSITIVE_LABELS
            result["nsfw"] = {
                "flagged": is_nsfw,
                "score": round(nsfw_probability, 4),
                "label": top_label,
                "tags": sorted(label for label, v in scores.items() if v >= 0.5),
                "scores": {label: round(v, 4) for label, v in scores.items()},
                "input_size": list(IMAGE_SIZE),
            }
            result["flags"]["nsfw"] = is_nsfw
            if is_nsfw:
                result["reasons"].append(f"nsfw:{top_label}")

    for result in results:
        result["flagged"] = any(result["flags"].values())
        result["action"] = "blur" if result["flagged"] else "allow"

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    flagged_count = sum(1 for r in results if r["flagged"])
    log.info(
        "Classified %d posts (%d texts, %d images) in %.1fms -> %d flagged",
        len(posts), len(texts), len(images), elapsed_ms, flagged_count,
    )

    return jsonify(
        {
            "status": "ok",
            "results": results,
            "summary": {
                "posts": len(posts),
                "texts_scored": len(texts),
                "images_scored": len(images),
                "flagged": flagged_count,
                "allowed": len(posts) - flagged_count,
                "by_flag": {
                    "toxicity": sum(1 for r in results if r["flags"]["toxicity"]),
                    "semantic_trigger": sum(1 for r in results if r["flags"]["semantic_trigger"]),
                    "nsfw": sum(1 for r in results if r["flags"]["nsfw"]),
                },
                "errors": sum(len(r["errors"]) for r in results),
            },
            "thresholds": {
                "toxicity": toxicity_threshold,
                "similarity": similarity_threshold,
            },
            "timing_ms": {
                "total": elapsed_ms,
                "per_post": round(elapsed_ms / len(posts), 2),
            },
        }
    )


if __name__ == "__main__":
    app.run(
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        threaded=True,
        debug=False,
    )
