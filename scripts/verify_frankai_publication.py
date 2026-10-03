#!/usr/bin/env python3
"""Verify FrankAI publication payload and source release identity."""
from __future__ import annotations
import argparse,json,sys
from pathlib import Path
from jsonschema import Draft202012Validator
ROOT=Path(__file__).resolve().parents[1]
SCHEMA=ROOT/"schemas"/"integration"/"frankai"/"1.0"/"publish.schema.json"

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--payload",required=True);ap.add_argument("--release-manifest",required=True);a=ap.parse_args()
    p=json.loads(Path(a.payload).read_text());r=json.loads(Path(a.release_manifest).read_text());errs=[]
    for e in Draft202012Validator(json.loads(SCHEMA.read_text())).iter_errors(p): errs.append(e.message)
    if p.get("release",{}).get("release_id")!=r.get("release_id"): errs.append("FI-001 release identity mismatch")
    if p.get("package_sha256")!=r.get("package_sha256"): errs.append("FI-002 package digest mismatch")
    if p.get("agent")!=r.get("agent"): errs.append("FI-003 agent identity/version mismatch")
    if p.get("rights_status") not in {"VERIFIED","RESTRICTED"}: errs.append("FI-004 rights state not publishable")
    if p.get("evaluation",{}).get("observed_outcome")!="PASS": errs.append("FI-005 evaluation outcome not PASS")
    if errs:
        [print(x) for x in errs];return 1
    print("PASS FrankAI publication verification");return 0
if __name__=="__main__":sys.exit(main())
