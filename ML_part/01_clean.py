"""
Step 1: Cleaning

Raw source files have real problems worth fixing, not just formatting:
  - clickbait_data.txt: every line is duplicated exactly (32,000 lines, only
    16,000 unique) -- likely a build artifact in the upstream repo.
  - non_clickbait_data.txt: contains ~10,000 blank lines mixed in among the
    real headlines.

Output: a single cleaned, deduplicated, labeled CSV ready for preprocessing.
"""

import csv

RAW_CLICKBAIT = "clickbait_data.txt"
RAW_NON_CLICKBAIT = "non_clickbait_data.txt"
OUT_CSV = "clean_labeled.csv"


def load_unique_lines(path: str) -> list[str]:
    seen = set()
    lines = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            key = line.lower()
            if key in seen:
                continue
            seen.add(key)
            lines.append(line)
    return lines


def main():
    clickbait = load_unique_lines(RAW_CLICKBAIT)
    non_clickbait = load_unique_lines(RAW_NON_CLICKBAIT)

    print(f"clickbait:     {len(clickbait)} unique headlines (raw file had duplicates)")
    print(f"non-clickbait: {len(non_clickbait)} unique headlines (raw file had blank lines)")

    # Cross-file duplicate check -- a headline appearing in both lists would be
    # a labeling contradiction, and would leak into both train and eval sets.
    overlap = set(h.lower() for h in clickbait) & set(h.lower() for h in non_clickbait)
    if overlap:
        print(f"WARNING: {len(overlap)} headlines appear in BOTH files -- dropping from both")
        clickbait = [h for h in clickbait if h.lower() not in overlap]
        non_clickbait = [h for h in non_clickbait if h.lower() not in overlap]

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["text", "label"])
        for h in clickbait:
            writer.writerow([h, 1])
        for h in non_clickbait:
            writer.writerow([h, 0])

    print(f"\nWrote {len(clickbait) + len(non_clickbait)} labeled rows to {OUT_CSV}")
    print(f"  positive (clickbait):     {len(clickbait)}")
    print(f"  negative (non-clickbait): {len(non_clickbait)}")


if __name__ == "__main__":
    main()
