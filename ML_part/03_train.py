"""
Step 3: Train the baseline model

TF-IDF + Logistic Regression -- fast, interpretable, and a legitimate
baseline to beat before reaching for anything heavier. Word-level unigrams
and bigrams, since "you won't" and "believe this" as phrases carry more
signal than either word alone.
"""

import joblib
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix

train_df = pd.read_csv("train.csv")
val_df = pd.read_csv("val.csv")

vectorizer = TfidfVectorizer(
    ngram_range=(1, 2),
    max_features=20_000,
    min_df=2,
    sublinear_tf=True,
)
X_train = vectorizer.fit_transform(train_df["text"])
X_val = vectorizer.transform(val_df["text"])

model = LogisticRegression(max_iter=1000, C=1.0)
model.fit(X_train, train_df["label"])

val_preds = model.predict(X_val)
print("=== Validation performance ===")
print(classification_report(val_df["label"], val_preds, target_names=["non-clickbait", "clickbait"]))
print("Confusion matrix (rows=actual, cols=predicted):")
print(confusion_matrix(val_df["label"], val_preds))

# Most influential words in each direction -- worth eyeballing for sanity,
# not just trusting the accuracy number blindly.
feature_names = vectorizer.get_feature_names_out()
coefs = model.coef_[0]
top_positive = coefs.argsort()[-15:][::-1]
top_negative = coefs.argsort()[:15]
print("\nTop clickbait-indicating terms:", [feature_names[i] for i in top_positive])
print("Top non-clickbait-indicating terms:", [feature_names[i] for i in top_negative])

joblib.dump(vectorizer, "vectorizer.joblib")
joblib.dump(model, "model.joblib")
print("\nSaved vectorizer.joblib and model.joblib")
