#!/usr/bin/env python3
"""Verify compilation manifest, digests and governance preservation."""
from __future__ import annotations
import argparse,hashlib,json,sys
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT=Path(__file__).resolve().parents[1]
SCHEMA=ROOT/"schemas"/"compiler"/"1.0"/"manifest.schema.json"

def canonical_sha(obj):
    return hashlib.sha256(json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--aps",required=True);ap.add_argument("--artifact",required=True);ap.add_argument("--manifest",required=True);a=ap.parse_args()
    aps=json.loads(Path(a.aps).read_text());man=json.loads(Path(a.manifest).read_text());artifact=Path(a.artifact).read_bytes()
    errs=[e.message for e in Draft202012Validator(json.loads(SCHEMA.read_text())).iter_errors(man)]
    if man.get("source_sha256")!=canonical_sha(aps): errs.append("CP-001 source APS digest mismatch")
    if man.get("artifact_sha256")!=hashlib.sha256(artifact).hexdigest(): errs.append("CP-002 runtime artifact digest mismatch")
    text=artifact.decode()
    auth=aps["governance"]["authority"]
    # Compiler must not silently invent execution/delegation rights.
    if not auth.get("execution") and "Execution authority: none" not in text: errs.append("CP-003 missing no-execution boundary")
    if not auth.get("delegation") and "Delegation authority: none" not in text: errs.append("CP-004 missing no-delegation boundary")
    for p in auth.get("prohibited",[]):
        if p not in text: errs.append(f"CP-005 prohibited action missing from runtime artifact: {p}")
    if errs:
        [print(x) for x in errs];return 1
    print("PASS compilation verification");return 0
if __name__=="__main__":sys.exit(main())
