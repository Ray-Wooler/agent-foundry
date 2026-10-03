#!/usr/bin/env python3
"""PromptForge transformation-record validator."""
from __future__ import annotations
import argparse, hashlib, json, sys
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT=Path(__file__).resolve().parents[1]
SCHEMA=ROOT/"schemas"/"promptforge"/"1.0"/"transformation.schema.json"
REQUIRED_STAGES=[
"SOURCE_CAPTURE","INTENT_ANALYSIS","DEFECT_ANALYSIS","ONTOLOGY_MAPPING",
"CAPABILITY_EXTRACTION","GOVERNANCE_CONSTRUCTION","EPISTEMIC_CONSTRUCTION",
"OPERATIONAL_CONSTRUCTION","CANDIDATE_GENERATION","VALIDATION","TRANSFORMATION_RECORD"]

def load(path): return json.loads(Path(path).read_text())
def canonical_sha(obj):
    payload=json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()

def validate(path):
    doc=load(path); schema=load(SCHEMA); errors=[]
    for e in sorted(Draft202012Validator(schema).iter_errors(doc),key=lambda e:list(e.absolute_path)):
        errors.append(f"SCHEMA:{'/'.join(map(str,e.absolute_path)) or '$'}: {e.message}")
    if errors: return errors

    source=doc["source"]; candidate=doc["candidate"]; integrity=doc["integrity"]
    if source["sha256"] != integrity["source_sha256"]:
        errors.append("PF-001: source digest differs from integrity.source_sha256")
    if candidate["sha256"] != integrity["candidate_sha256"]:
        errors.append("PF-002: candidate digest differs from integrity.candidate_sha256")
    actual_candidate=canonical_sha(candidate["aps_document"])
    if candidate["sha256"] != actual_candidate:
        errors.append("PF-003: candidate.sha256 does not match canonical APS document digest")

    stages=doc["stages"]; names=[s["name"] for s in stages]
    if len(names)!=len(set(names)):
        errors.append("PF-004: transformation stages must not repeat")
    missing=[s for s in REQUIRED_STAGES if s not in names]
    if missing: errors.append(f"PF-005: required stages missing: {missing}")
    order=[names.index(s) for s in REQUIRED_STAGES if s in names]
    if order != sorted(order):
        errors.append("PF-006: transformation stages are out of canonical order")

    by_name={s["name"]:s for s in stages}
    terminal=doc["status"]
    failed=[s["name"] for s in stages if s["status"]=="FAIL"]
    review=[s["name"] for s in stages if s["status"] in {"PARTIAL","REQUIRES_REVIEW"}]
    if failed and terminal!="FAILED":
        errors.append("PF-007: a failed stage requires transformation status FAILED")
    if not failed and review and terminal=="CANDIDATE":
        errors.append("PF-008: PARTIAL/REQUIRES_REVIEW stages cannot yield CANDIDATE")
    if terminal=="CANDIDATE":
        if by_name["VALIDATION"]["status"]!="PASS":
            errors.append("PF-009: CANDIDATE requires VALIDATION PASS")
        if source["rights_status"]=="PROHIBITED":
            errors.append("PF-010: prohibited source rights cannot yield CANDIDATE")
    if source["rights_status"] in {"UNVERIFIED","RESTRICTED"} and not doc.get("warnings"):
        errors.append("PF-011: non-verified source rights require an explicit warning")
    for s in stages:
        if s["status"] in {"PASS","PARTIAL","REQUIRES_REVIEW"} and not s["evidence"]:
            errors.append(f"PF-012: stage {s['name']} status {s['status']} requires evidence")
    return errors

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("files",nargs="+"); args=ap.parse_args()
    failed=False
    for f in args.files:
        errs=validate(f)
        if errs:
            failed=True; print(f"FAIL {f}"); [print(f"  {e}") for e in errs]
        else: print(f"PASS {f}")
    return 1 if failed else 0
if __name__=="__main__": sys.exit(main())
