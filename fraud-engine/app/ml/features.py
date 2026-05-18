"""
Train/serve symmetric feature transforms for the fraud model.

The training notebook fits transforms on the train slice only, then both the
notebook and the inference scorer call the same `apply_transforms` function.
Train/serve skew is impossible because there is a single function on both
sides — anything that drifts has to drift in both.

A fitted `Transforms` bundle is:
    encoder           — sklearn OrdinalEncoder fit on train categoricals
    cat_cols          — ordered list of categorical column names
    card_mean         — {card1 value -> mean TransactionAmt on train}
    card_mean_global  — fallback mean used for unseen / NaN card1
    feature_order     — exact column order the model expects
"""
from __future__ import annotations

from typing import TypedDict

import numpy as np
import pandas as pd
from sklearn.preprocessing import OrdinalEncoder


_MISSING_TOKEN = "__MISSING__"
_TARGET_COL = "isFraud"
_ID_COL = "TransactionID"


class Transforms(TypedDict):
    encoder: OrdinalEncoder
    cat_cols: list[str]
    card_mean: dict
    card_mean_global: float
    feature_order: list[str]


def _add_derived_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Stateless per-row signals — identical on train and serve."""
    out = df.copy()
    if "TransactionDT" in out.columns:
        out["hour"] = (out["TransactionDT"] / 3600) % 24
        out["dow"] = (out["TransactionDT"] / (3600 * 24)) % 7
    if "TransactionAmt" in out.columns:
        out["amt_decimal"] = out["TransactionAmt"] % 1
        out["amt_log"] = np.log1p(out["TransactionAmt"])
    if "id_01" in out.columns:
        out["has_identity"] = out["id_01"].notna().astype(int)
    out["nan_count"] = df.isna().sum(axis=1)
    return out


def fit_transforms(train_df: pd.DataFrame) -> Transforms:
    """Fit all train-only transforms in one pass. Returns the persistable bundle."""
    derived = _add_derived_columns(train_df)
    cat_cols = derived.select_dtypes(include=["object"]).columns.tolist()

    cat_data = derived[cat_cols].fillna(_MISSING_TOKEN).astype(str)
    encoder = OrdinalEncoder(
        handle_unknown="use_encoded_value",
        unknown_value=-1,
        dtype=np.float32,
    )
    encoder.fit(cat_data)

    if "card1" in derived.columns and "TransactionAmt" in derived.columns:
        card_mean = derived.groupby("card1")["TransactionAmt"].mean().to_dict()
        card_mean_global = float(derived["TransactionAmt"].mean())
    else:
        card_mean = {}
        card_mean_global = 0.0

    base = [c for c in derived.columns if c not in (_TARGET_COL, _ID_COL)]
    feature_order = base + ["card1_amt_mean", "amt_to_card_mean"]

    return Transforms(
        encoder=encoder,
        cat_cols=cat_cols,
        card_mean=card_mean,
        card_mean_global=card_mean_global,
        feature_order=feature_order,
    )


def apply_transforms(df: pd.DataFrame, t: Transforms) -> pd.DataFrame:
    """Project a transactions DataFrame into the model's input space.

    Order matters: card1 aggregation is computed BEFORE encoding so it stays
    keyed on the raw card1 value regardless of whether card1 ended up in
    cat_cols on this particular fit.
    """
    out = _add_derived_columns(df)

    # 1. Card1 aggregation (train-only stats, applied at serve time).
    if "card1" in out.columns:
        out["card1_amt_mean"] = (
            out["card1"].map(t["card_mean"]).fillna(t["card_mean_global"])
        )
    else:
        out["card1_amt_mean"] = t["card_mean_global"]

    if "TransactionAmt" in out.columns:
        out["amt_to_card_mean"] = out["TransactionAmt"] / (out["card1_amt_mean"] + 1.0)

    # 2. Encode categoricals. Reindex so missing columns at serve time still
    # produce an aligned matrix (becomes _MISSING_TOKEN -> -1 via unknown).
    cat_cols = t["cat_cols"]
    cat_frame = pd.DataFrame(index=out.index)
    for c in cat_cols:
        cat_frame[c] = out[c] if c in out.columns else _MISSING_TOKEN
    cat_frame = cat_frame.fillna(_MISSING_TOKEN).astype(str)
    encoded = t["encoder"].transform(cat_frame)
    for i, c in enumerate(cat_cols):
        out[c] = encoded[:, i]

    # 3. Force exact column order. Missing -> NaN (XGBoost handles NaN natively).
    return out.reindex(columns=t["feature_order"])
