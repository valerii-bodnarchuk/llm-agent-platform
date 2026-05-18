# ---
# jupyter:
#   jupytext:
#     formats: py:percent,ipynb
#     text_representation:
#       extension: .py
#       format_name: percent
#       format_version: '1.3'
#       jupytext_version: 1.16.0
#   kernelspec:
#     display_name: Python 3
#     language: python
#     name: python3
# ---

# %% [markdown]
# # IEEE-CIS Fraud Detection — XGBoost baseline
#
# Goals:
# 1. Train a fraud model on the IEEE-CIS dataset (~590k transactions, ~3.5% fraud rate).
# 2. Establish a defensible train/eval methodology (time-ordered split, no leakage).
# 3. Produce calibrated probabilities (no `scale_pos_weight`) so threshold
#    routing into ALLOW / REVIEW / BLOCK can be tuned from the PR curve.
# 4. Ship a train/serve-symmetric transform bundle (`transforms.joblib`) so the
#    FastAPI scorer cannot drift away from training.

# %%
from __future__ import annotations

import sys
import time
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] if "__file__" in globals() else Path.cwd().parent
sys.path.insert(0, str(ROOT))

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import shap
import xgboost as xgb
from sklearn.metrics import (
    average_precision_score,
    precision_recall_curve,
    roc_auc_score,
)

from app.ml.features import apply_transforms, fit_transforms

warnings.filterwarnings("ignore", category=UserWarning)

DATA_DIR = ROOT / "data"
ARTIFACTS_DIR = ROOT / "app" / "ml" / "artifacts"
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

print(f"Project root: {ROOT}")
print(f"XGBoost: {xgb.__version__} | SHAP: {shap.__version__}")

# %% [markdown]
# ## Step 1 — Load and left-join transaction with identity
#
# `left` join keeps every transaction; the absence of identity is itself a
# signal we capture as `has_identity`.

# %%
t0 = time.time()
tx = pd.read_csv(DATA_DIR / "train_transaction.csv", low_memory=False)
idf = pd.read_csv(DATA_DIR / "train_identity.csv", low_memory=False)
df = tx.merge(idf, how="left", on="TransactionID")
del tx, idf  # free ~1 GB of RAM
print(f"  Loaded + merged in {time.time() - t0:.1f}s")
print(f"  Shape: {df.shape}")
print(f"  Fraud rate: {df['isFraud'].mean():.4%}")
print(f"  Memory: {df.memory_usage(deep=True).sum() / 1e9:.2f} GB")

# %% [markdown]
# ## Step 2 — Time-ordered split (no leakage)
#
# Random splitting on time-series fraud data leaks future information into
# training and inflates metrics. We sort by `TransactionDT` and take the last
# 20% chronologically as the validation slice — the same shape as the
# production setup, where you predict the future from the past.

# %%
df = df.sort_values("TransactionDT").reset_index(drop=True)
split_idx = int(len(df) * 0.8)
train_df = df.iloc[:split_idx].copy()
val_df = df.iloc[split_idx:].copy()
del df
print(f"  Train: {train_df.shape}, fraud rate {train_df['isFraud'].mean():.4%}")
print(f"  Val:   {val_df.shape}, fraud rate {val_df['isFraud'].mean():.4%}")

# %% [markdown]
# ## Step 3 — Fit transforms on TRAIN ONLY, apply to both
#
# The encoder, the per-card1 mean, and the resolved feature order are all fit
# on the train slice. The same `apply_transforms` function is imported by the
# FastAPI scorer at serve time — single source of truth, single point of skew.

# %%
t0 = time.time()
transforms = fit_transforms(train_df)
X_train = apply_transforms(train_df.drop(columns=["isFraud"]), transforms)
y_train = train_df["isFraud"].values
X_val = apply_transforms(val_df.drop(columns=["isFraud"]), transforms)
y_val = val_df["isFraud"].values
del train_df, val_df
print(f"  Transforms fit + applied in {time.time() - t0:.1f}s")
print(f"  X_train: {X_train.shape}")
print(f"  X_val:   {X_val.shape}")
print(f"  Cat cols encoded: {len(transforms['cat_cols'])}")

# %% [markdown]
# ## Step 4 — Train XGBoost
#
# **No `scale_pos_weight`.** Reweighting the loss distorts predicted
# probabilities — fine for pure ranking (AUC), wrong for threshold routing
# where we want P(fraud) to mean what it says. We compensate at inference
# time by tuning thresholds from the PR curve (Step 5).

# %%
t0 = time.time()
model = xgb.XGBClassifier(
    n_estimators=2000,
    learning_rate=0.02,
    max_depth=8,
    subsample=0.8,
    colsample_bytree=0.8,
    eval_metric="aucpr",
    early_stopping_rounds=200,
    tree_method="hist",
    n_jobs=-1,
    random_state=42,
)
model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=100)
print(f"  Training finished in {time.time() - t0:.1f}s")
print(f"  Best iteration: {model.best_iteration}")

# %% [markdown]
# ## Step 5 — Evaluate (ROC-AUC + PR-AUC + threshold candidates)
#
# `precision_recall_curve` returns the points; we pick concrete thresholds at
# four operating points relevant to the agent platform's three-way decision:
#  * `precision >= 0.99` → safe to auto-BLOCK
#  * `precision >= 0.95` → high-confidence block tier
#  * `recall    >= 0.90` → REVIEW-grade catch rate
#  * `recall    >= 0.85` → loosest review tier

# %%
proba_val = model.predict_proba(X_val)[:, 1]
roc = roc_auc_score(y_val, proba_val)
pr = average_precision_score(y_val, proba_val)
print(f"  ROC-AUC: {roc:.4f}")
print(f"  PR-AUC:  {pr:.4f}")

prec, rec, thr = precision_recall_curve(y_val, proba_val)


def _at_recall(target: float) -> dict | None:
    idx = np.where(rec >= target)[0]
    if len(idx) == 0:
        return None
    i = int(idx[-1])
    return {
        "threshold": float(thr[i - 1]) if i > 0 else 0.0,
        "precision": float(prec[i]),
        "recall": float(rec[i]),
    }


def _at_precision(target: float) -> dict | None:
    idx = np.where(prec >= target)[0]
    if len(idx) == 0:
        return None
    i = int(idx[0])
    return {
        "threshold": float(thr[i - 1]) if i > 0 else 0.0,
        "precision": float(prec[i]),
        "recall": float(rec[i]),
    }


threshold_candidates = {
    "block_grade_precision_0.99": _at_precision(0.99),
    "high_precision_0.95": _at_precision(0.95),
    "review_recall_0.90": _at_recall(0.90),
    "review_recall_0.85": _at_recall(0.85),
}
print("  Threshold candidates:")
for name, t in threshold_candidates.items():
    print(f"    {name}: {t}")

# %% [markdown]
# ## Step 6 — SHAP summary (2k-row sample, saved as PNG)

# %%
t0 = time.time()
sample = X_val.sample(min(2000, len(X_val)), random_state=42)
explainer = shap.TreeExplainer(model)
shap_values = explainer.shap_values(sample)
shap.summary_plot(shap_values, sample, show=False, max_display=20)
shap_png = ARTIFACTS_DIR / "shap_summary.png"
plt.tight_layout()
plt.savefig(shap_png, dpi=120, bbox_inches="tight")
plt.close()
print(f"  SHAP summary in {time.time() - t0:.1f}s -> {shap_png}")

# %% [markdown]
# ## Step 7 — Persist artifacts (single train/serve contract)

# %%
joblib.dump(model, ARTIFACTS_DIR / "fraud_xgb.joblib")
joblib.dump(transforms, ARTIFACTS_DIR / "transforms.joblib")
joblib.dump(threshold_candidates, ARTIFACTS_DIR / "thresholds.joblib")
print(f"  Saved: fraud_xgb.joblib, transforms.joblib, thresholds.joblib -> {ARTIFACTS_DIR}")

try:
    from onnxmltools import convert_xgboost
    from onnxmltools.convert.common.data_types import FloatTensorType

    initial_type = [("input", FloatTensorType([None, X_train.shape[1]]))]
    onnx_model = convert_xgboost(model, initial_types=initial_type)
    (ARTIFACTS_DIR / "fraud_xgb.onnx").write_bytes(onnx_model.SerializeToString())
    print(f"  Saved: fraud_xgb.onnx ({(ARTIFACTS_DIR / 'fraud_xgb.onnx').stat().st_size / 1e6:.1f} MB)")
except Exception as e:
    print(f"  ONNX export failed (non-fatal): {type(e).__name__}: {e}")

# %% [markdown]
# ## Summary
#
# Reproducibility checklist for this run:
#  - Single train-only fit captured in `transforms.joblib`
#  - Time-ordered split — no temporal leakage
#  - Probabilities uncalibrated by class reweighting → thresholds derived from PR curve
#  - Same `apply_transforms` import path used by training and serving
#  - SHAP summary persisted for explainability hand-off to the LangGraph agent
