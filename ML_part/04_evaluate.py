"""
Step 4: Final evaluation on the held-out test set.

This is the number that matters -- the val set was used implicitly while
eyeballing the model during development, so it's slightly optimistic. The
test set has never been touched until this script runs.
"""

import joblib
import pandas as pd
from sklearn.metrics import classification_report, confusion_matrix, roc_auc_score

vectorizer = joblib.load("vectorizer.joblib")
model = joblib.load("model.joblib")
test_df = pd.read_csv("test.csv")

X_test = vectorizer.transform(test_df["text"])
preds = model.predict(X_test)
probs = model.predict_proba(X_test)[:, 1]

print("=== FINAL test-set performance (held out, untouched until now) ===")
print(classification_report(test_df["label"], preds, target_names=["non-clickbait", "clickbait"]))
print("Confusion matrix (rows=actual, cols=predicted):")
print(confusion_matrix(test_df["label"], preds))
print(f"ROC-AUC: {roc_auc_score(test_df['label'], probs):.4f}")

# A few real misclassifications -- worth reading, not just the aggregate score.
test_df = test_df.copy()
test_df["pred"] = preds
test_df["prob"] = probs
wrong = test_df[test_df["label"] != test_df["pred"]]
print(f"\n{len(wrong)} misclassified examples out of {len(test_df)}. Sample:")
for _, row in wrong.sample(min(8, len(wrong)), random_state=1).iterrows():
    actual = "clickbait" if row["label"] == 1 else "non-clickbait"
    predicted = "clickbait" if row["pred"] == 1 else "non-clickbait"
    print(f"  actual={actual:14s} predicted={predicted:14s} (p={row['prob']:.2f})  {row['text']}")
