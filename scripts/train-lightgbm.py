#!/usr/bin/env python3
"""
RTKdata Integrity Engine — LightGBM Quality Predictor Training
===============================================================
Trains a LightGBM model to predict fix_rate from station + environment features.
Exports to ONNX format for serving in Node.js via onnxruntime-node.

Usage:
    python scripts/train-lightgbm.py --db /data/integrity.db --output /data/quality-model.onnx

Requirements:
    pip install lightgbm scikit-learn onnxmltools skl2onnx numpy pandas
"""

import argparse
import json
import math
import os
import sqlite3
import sys
from datetime import datetime

import numpy as np

def load_data(db_path: str):
    """Load training data from SQLite: sessions joined with station scores + environment."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Join sessions with station scores
    query = """
    SELECT
        s.fix_rate,
        s.avg_age,
        s.duration,
        s.latitude as user_lat,
        s.longitude as user_lon,
        s.login_time,
        st.latitude as station_lat,
        st.longitude as station_lon,
        st.network,
        sc.uq_score,
        sc.reliability_score,
        sc.avg_fix_rate as station_avg_fix,
        sc.uptime_7d,
        sc.zero_fix_ratio,
        sc.session_count as station_sessions
    FROM rtk_sessions s
    LEFT JOIN stations st ON s.station = st.name
    LEFT JOIN station_scores sc ON s.station = sc.station_name
    WHERE s.fix_rate IS NOT NULL
      AND s.station IS NOT NULL
      AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      AND st.latitude IS NOT NULL AND st.longitude IS NOT NULL
      AND NOT (s.fix_rate = 0 AND s.duration >= 0 AND s.duration < 60)
    """

    rows = conn.execute(query).fetchall()
    conn.close()

    if len(rows) < 100:
        print(f"Only {len(rows)} rows — need at least 100 for training")
        sys.exit(1)

    print(f"Loaded {len(rows)} training samples")
    return rows


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def extract_features(rows):
    """Build feature matrix from raw rows."""
    X = []
    y = []

    for r in rows:
        try:
            login_time = r["login_time"] or 0
            # Time features
            if isinstance(login_time, (int, float)) and login_time > 1e12:
                dt = datetime.utcfromtimestamp(login_time / 1000)
            elif isinstance(login_time, (int, float)) and login_time > 1e9:
                dt = datetime.utcfromtimestamp(login_time)
            else:
                dt = datetime(2026, 1, 1)

            hour = dt.hour
            day_of_week = dt.weekday()
            month = dt.month

            # Distance
            baseline_km = haversine_km(
                r["user_lat"] or 0, r["user_lon"] or 0,
                r["station_lat"] or 0, r["station_lon"] or 0
            )

            features = [
                r["uq_score"] or 0,                    # 0: station UQ score
                r["uptime_7d"] or 0,                    # 1: station 7d uptime
                r["station_avg_fix"] or 0,              # 2: station historical fix rate
                r["zero_fix_ratio"] or 0,               # 3: station zero-fix ratio
                math.log1p(r["station_sessions"] or 0), # 4: log(session count)
                min(baseline_km, 200),                   # 5: baseline distance (capped)
                hour,                                    # 6: hour of day
                math.sin(2 * math.pi * hour / 24),      # 7: hour sin (cyclic)
                math.cos(2 * math.pi * hour / 24),      # 8: hour cos (cyclic)
                abs(r["user_lat"] or 0),                 # 9: absolute latitude
                1 if (r["network"] or "").lower() == "onocoy" else 0,  # 10: is_onocoy
                r["reliability_score"] or 0,             # 11: reliability score
                r["avg_age"] or 0,                       # 12: correction age
                min(r["duration"] or 0, 3600) if (r["duration"] or 0) > 0 else 300,  # 13: duration (capped)
                day_of_week,                             # 14: day of week
                month,                                   # 15: month
                math.sin(2 * math.pi * month / 12),      # 16: month sin (seasonal)
                math.cos(2 * math.pi * month / 12),      # 17: month cos (seasonal)
            ]

            X.append(features)
            y.append(min(100, max(0, r["fix_rate"] or 0)))

        except Exception:
            continue

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32)


FEATURE_NAMES = [
    "station_uq_score", "station_uptime", "station_avg_fix_rate",
    "station_zero_fix_ratio", "station_session_count_log", "baseline_distance_km",
    "hour_of_day", "hour_sin", "hour_cos", "latitude_abs", "is_onocoy",
    "reliability_score", "correction_age", "duration", "day_of_week",
    "month", "month_sin", "month_cos",
]


def train_and_export(X, y, output_path):
    """Train LightGBM and export to ONNX."""
    try:
        import lightgbm as lgb
        from sklearn.model_selection import train_test_split
    except ImportError:
        print("Install: pip install lightgbm scikit-learn")
        sys.exit(1)

    # Split
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    print(f"Train: {len(X_train)}, Test: {len(X_test)}")

    # Train
    dtrain = lgb.Dataset(X_train, y_train, feature_name=FEATURE_NAMES)
    dtest = lgb.Dataset(X_test, y_test, feature_name=FEATURE_NAMES, reference=dtrain)

    params = {
        "objective": "regression",
        "metric": "rmse",
        "learning_rate": 0.05,
        "max_depth": 8,
        "num_leaves": 31,
        "min_child_samples": 20,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "reg_alpha": 0.1,
        "reg_lambda": 0.1,
        "verbose": -1,
    }

    model = lgb.train(
        params, dtrain,
        num_boost_round=300,
        valid_sets=[dtest],
        callbacks=[lgb.early_stopping(20), lgb.log_evaluation(50)],
    )

    # Evaluate
    from sklearn.metrics import mean_squared_error, r2_score
    y_pred = model.predict(X_test)
    rmse = math.sqrt(mean_squared_error(y_test, y_pred))
    r2 = r2_score(y_test, y_pred)
    print(f"\nTest RMSE: {rmse:.2f}")
    print(f"Test R²:   {r2:.4f}")

    # Feature importance
    importance = model.feature_importance(importance_type="gain")
    fi = sorted(zip(FEATURE_NAMES, importance), key=lambda x: -x[1])
    print("\nFeature Importance (gain):")
    for name, imp in fi[:10]:
        print(f"  {name}: {imp:.0f}")

    # Export to ONNX
    try:
        import onnxmltools
        from onnxmltools.convert import convert_lightgbm
        from onnxconverter_common.data_types import FloatTensorType

        initial_types = [("features", FloatTensorType([None, len(FEATURE_NAMES)]))]
        onnx_model = convert_lightgbm(model, initial_types=initial_types)
        onnxmltools.utils.save_model(onnx_model, output_path)
        print(f"\nONNX model saved to {output_path}")
    except ImportError:
        print("\nONNX export unavailable (pip install onnxmltools onnxconverter-common)")
        # Save as LightGBM native format instead
        native_path = output_path.replace(".onnx", ".lgb")
        model.save_model(native_path)
        print(f"LightGBM native model saved to {native_path}")

    # Save metadata
    meta = {
        "feature_names": FEATURE_NAMES,
        "n_features": len(FEATURE_NAMES),
        "n_train": len(X_train),
        "n_test": len(X_test),
        "rmse": round(rmse, 4),
        "r2": round(r2, 4),
        "feature_importance": {name: round(float(imp), 2) for name, imp in fi},
        "trained_at": datetime.utcnow().isoformat(),
        "params": params,
    }
    meta_path = output_path.replace(".onnx", "-meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Metadata saved to {meta_path}")

    return model, meta


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train LightGBM quality predictor")
    parser.add_argument("--db", default="./data/integrity.db", help="SQLite database path")
    parser.add_argument("--output", default="./data/quality-model.onnx", help="ONNX output path")
    args = parser.parse_args()

    rows = load_data(args.db)
    X, y = extract_features(rows)
    print(f"Feature matrix: {X.shape}")
    train_and_export(X, y, args.output)
