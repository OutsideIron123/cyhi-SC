"""
Quick calibration script for ZenLayer.

Sends a spread of known-obvious test cases to a running instance and prints
scores side by side, so you can see whether the models are behaving
sensibly (even if not perfectly) before trusting the default thresholds.

Usage:
    pip install requests
    python calibrate.py

For the image battery: drop a few of your own test images in an "images/"
folder next to this script (any normal photos are fine for the "should
allow" cases -- you supply your own image for anything you expect to be
flagged, since this script won't generate or fetch that kind of content).
"""

import base64
import os

import requests

BASE_URL = "http://localhost:8000"
IMAGE_DIR = "images"

TOXICITY_CASES = [
    ("mild/neutral", "had a nice walk today"),
    ("mild/neutral", "looking forward to the weekend"),
    ("insult, no profanity", "you are a worthless idiot and everyone hates you"),
    ("insult, with profanity", "you're a fucking moron and everyone hates you"),
    ("direct threat", "i will hurt you if you say that again"),
    ("slur-adjacent hostility", "shut up you disgusting piece of trash"),
]

TRIGGER_PHRASE = "layoffs"
SEMANTIC_CASES = [
    ("unrelated", "had a nice walk today"),
    ("loosely related", "half my team got let go today"),
    ("clearly related, no keyword", "my company is cutting a third of its workforce"),
    ("exact keyword", "there were massive layoffs at my company"),
]


def run_toxicity_battery():
    print("\n=== TOXICITY ===")
    print(f"{'label':<25} {'score':>8}   text")
    for label, text in TOXICITY_CASES:
        resp = requests.post(
            f"{BASE_URL}/classify",
            json={"posts": [{"id": 1, "text": text}], "toxicity_threshold": 0.0},
        )
        score = resp.json()["results"][0]["toxicity"]["score"]
        print(f"{label:<25} {score:>8.4f}   {text}")


def run_semantic_battery():
    print(f"\n=== SEMANTIC TRIGGER MATCH (trigger = '{TRIGGER_PHRASE}') ===")
    requests.post(f"{BASE_URL}/update-triggers", json={"triggers": [TRIGGER_PHRASE]})
    print(f"{'label':<28} {'similarity':>10}   text")
    for label, text in SEMANTIC_CASES:
        resp = requests.post(
            f"{BASE_URL}/classify",
            json={"posts": [{"id": 1, "text": text}], "similarity_threshold": 0.0},
        )
        sim = resp.json()["results"][0]["semantic"]["max_similarity"]
        print(f"{label:<28} {sim:>10.4f}   {text}")


def _b64_of(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def run_image_battery():
    print(f"\n=== NSFW IMAGE CLASSIFICATION (reading from ./{IMAGE_DIR}/) ===")
    if not os.path.isdir(IMAGE_DIR):
        print(f"(no '{IMAGE_DIR}/' folder found -- create it and drop in a few test images)")
        return

    files = sorted(
        f for f in os.listdir(IMAGE_DIR)
        if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif"))
    )
    if not files:
        print(f"(no image files found in '{IMAGE_DIR}/')")
        return

    print(f"{'file':<30} {'score':>8}   label   errors")
    for filename in files:
        path = os.path.join(IMAGE_DIR, filename)
        resp = requests.post(
            f"{BASE_URL}/classify",
            json={"posts": [{"id": filename, "image_base64": _b64_of(path)}]},
        )
        result = resp.json()["results"][0]
        if result["nsfw"]:
            print(
                f"{filename:<30} {result['nsfw']['score']:>8.4f}   "
                f"{result['nsfw']['label']:<8} {result['errors']}"
            )
        else:
            print(f"{filename:<30} {'--':>8}   (not scored) {result['errors']}")


def run_image_edge_cases():
    print("\n=== IMAGE EDGE CASES ===")

    # Invalid base64 -- should error on this post only, not crash the request.
    resp = requests.post(
        f"{BASE_URL}/classify",
        json={"posts": [{"id": "bad-b64", "image_base64": "not-valid-base64!!"}]},
    )
    result = resp.json()["results"][0]
    print(f"invalid base64      -> status {resp.status_code}, errors: {result['errors']}")

    # Oversized payload -- should be rejected with a clear message, not a crash.
    fake_large = base64.b64encode(b"0" * (9 * 1024 * 1024)).decode("ascii")  # 9MB > 8MB limit
    resp = requests.post(
        f"{BASE_URL}/classify",
        json={"posts": [{"id": "too-big", "image_base64": fake_large}]},
    )
    result = resp.json()["results"][0]
    print(f"oversized (9MB)      -> status {resp.status_code}, errors: {result['errors']}")

    # Text-only post mixed with an image post in the same batch -- image lane
    # should only run for the post that has one.
    resp = requests.post(
        f"{BASE_URL}/classify",
        json={"posts": [{"id": "text-only", "text": "just checking mixed batches"}]},
    )
    result = resp.json()["results"][0]
    print(f"text-only in batch   -> nsfw field is: {result['nsfw']}")


if __name__ == "__main__":
    run_toxicity_battery()
    run_semantic_battery()
    run_image_battery()
    run_image_edge_cases()
    print(
        "\nIf scores rise clearly as sentences get more extreme, the models are"
        " working -- the defaults (0.70 / 0.45) are just tuned conservatively."
        " If everything stays near-zero even for the slur/threat cases, that's"
        " a real bug worth investigating (model loading, quantization, or"
        " label matching), not just a threshold issue."
    )