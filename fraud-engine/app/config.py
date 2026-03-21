"""
Loads rules.yaml once at import time.
All rule functions and the scoring engine read from CONFIG.
To change thresholds or weights, edit config/rules.yaml — no code changes needed.
"""
import yaml
from pathlib import Path

_CONFIG_PATH = Path(__file__).parent.parent / "config" / "rules.yaml"

with open(_CONFIG_PATH) as _f:
    CONFIG: dict = yaml.safe_load(_f)
