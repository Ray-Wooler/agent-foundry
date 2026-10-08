#!/usr/bin/env python3
import subprocess
import sys

fixture="tests/fixtures/aps/1.5-alpha/invalid-contextual-authority-malformed-types.json"
result=subprocess.run(
    [sys.executable,"scripts/validate_aps.py",fixture],
    capture_output=True,
    text=True,
)
combined=result.stdout+"\n"+result.stderr
if result.returncode == 0:
    raise SystemExit("malformed CAC fixture unexpectedly passed validation")
if "Traceback (most recent call last)" in combined:
    raise SystemExit("APS validator crashed instead of returning validation findings")
required=("SCHEMA:","INV-017:","INV-018:","INV-019:","INV-021:")
missing=[marker for marker in required if marker not in combined]
if missing:
    raise SystemExit("missing expected validation findings: "+", ".join(missing))
print("APS_VALIDATOR_ROBUSTNESS_PASS")
