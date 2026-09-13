"""
Step 2: Preprocessing + stratified split

Deliberately light-touch preprocessing: lowercase and whitespace-normalize,
but KEEP punctuation and casing information available for now -- exclamation
marks and capitalization patterns are plausible signal for bait-style
headlines, not noise to strip. TF-IDF will decide what's useful.

Stratified split so each of train/val/test keeps the same ~50/50 class
balance as the full set.
"""

import re

import pandas as pd
from sklearn.model_selection import train_test_split

IN_CSV = "clean_labeled.csv"


def normalize(text: str) -> str:
    text = text.strip()
    text = re.sub(r"\s+", " ", text)          # collapse repeated whitespace
    text = text.encode("ascii", "ignore").decode("ascii")  # drop stray unicode artifacts
    return text


def main():
    df = pd.read_csv(IN_CSV)
    before = len(df)

    df["text"] = df["text"].astype(str).map(normalize)
    df = df[df["text"].str.len() > 0].drop_duplicates(subset="text")

    print(f"After normalization: {len(df)} rows (dropped {before - len(df)})")
    print(f"Class balance: {df['label'].value_counts().to_dict()}")

    # 70/15/15 stratified split
    train_df, temp_df = train_test_split(
        df, test_size=0.30, stratify=df["label"], random_state=42
    )
    val_df, test_df = train_test_split(
        temp_df, test_size=0.50, stratify=temp_df["label"], random_state=42
    )

    train_df.to_csv("train.csv", index=False)
    val_df.to_csv("val.csv", index=False)
    test_df.to_csv("test.csv", index=False)

    print(f"\ntrain: {len(train_df)}  val: {len(val_df)}  test: {len(test_df)}")
    for name, split in [("train", train_df), ("val", val_df), ("test", test_df)]:
        rate = split["label"].mean()
        print(f"  {name} positive rate: {rate:.3f}")


if __name__ == "__main__":
    main()
