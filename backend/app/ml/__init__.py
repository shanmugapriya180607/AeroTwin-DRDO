"""
Machine-learning layer.

Three modules, in the order the project methodology requires they be built:

    preprocessing        - NGAFID-MC ingest contract, column mapping, cleaning
    feature_engineering  - residual -> feature vector (never raw sensor -> model)
    anomaly_model        - Isolation Forest over residual features

The one design rule that governs all of it: **the model consumes residuals,
not sensor values**. A model trained on raw CHT learns "hot engines are sick",
which is false - a hot engine on a hot day at low airspeed is behaving exactly
as physics says it should. A model trained on the residual learns "this engine
is not doing what physics says it should", which is the actual fault signal.
"""

from .anomaly_model import IsolationForestDetector, anomaly_model
from .feature_engineering import (FEATURE_NAMES, cylinder_features,
                                  global_features, feature_frame)
from .predict import predict_engine_state
from .preprocessing import DATA_DICTIONARY, NgafidPreprocessor, ingest_report

__all__ = [
    "IsolationForestDetector",
    "anomaly_model",
    "FEATURE_NAMES",
    "cylinder_features",
    "global_features",
    "feature_frame",
    "predict_engine_state",
    "DATA_DICTIONARY",
    "NgafidPreprocessor",
    "ingest_report",
]
