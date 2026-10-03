#!/usr/bin/env python3
"""Validate Agent Foundry evaluation suites and completed evaluation runs."""
from __future__ import annotations
import argparse,json,sys
from pathlib import Path
from jsonschema import Draft202012Validator
ROOT=Path(__file__).resolve().parents[1]
SUITE_SCHEMA=ROOT/"schemas"/"evaluation"/"1.0"/"suite.schema.json"
RUN_SCHEMA=ROOT/"schemas"/"evaluation"/"1.0"/"run.schema.json"

def load(p): return json.loads(Path(p).read_text())
def schema_errors(doc,schema_path):
    schema=load(schema_path)
    return [f"SCHEMA:{'/'.join(map(str,e.absolute_path)) or '$'}: {e.message}" for e in sorted(Draft202012Validator(schema).iter_errors(doc),key=lambda e:list(e.absolute_path))]

def validate_suite(doc):
    errs=schema_errors(doc,SUITE_SCHEMA)
    if errs:return errs
    case_ids=[c["case_id"] for c in doc["cases"]]
    if len(case_ids)!=len(set(case_ids)): errs.append("EV-001: duplicate case_id")
    assertion_ids=[]
    for c in doc["cases"]:
        ids=[a["assertion_id"] for a in c["assertions"]]
        if len(ids)!=len(set(ids)): errs.append(f"EV-002: duplicate assertion_id in {c['case_id']}")
        assertion_ids.extend((c["case_id"],i) for i in ids)
    return errs

def validate_run(doc):
    errs=schema_errors(doc,RUN_SCHEMA)
    if errs:return errs
    policy=doc["policy_snapshot"]
    results=doc["results"]
    required=[r for r in results if r.get("required")]
    if doc["outcome"]=="PASS":
        bad=[r for r in required if r["outcome"]!="PASS"]
        if bad: errs.append("EV-003: PASS run contains required assertions that are not PASS")
        if not policy.get("allow_not_tested",False) and any(r["outcome"]=="NOT_TESTED" for r in results):
            errs.append("EV-004: NOT_TESTED cannot aggregate to PASS")
        if not policy.get("allow_not_applicable",True) and any(r["outcome"]=="NOT_APPLICABLE" for r in results):
            errs.append("EV-007: NOT_APPLICABLE cannot aggregate to PASS when policy disallows it")
    for r in results:
        if r["outcome"] in {"PASS","PARTIAL","FAIL"} and not r.get("evidence"):
            errs.append(f"EV-005: result {r['case_id']}:{r['assertion_id']} requires evidence")
        if r["assertion_type"]=="HUMAN_REVIEW" and r["outcome"]!="NOT_TESTED":
            if not r.get("reviewer") or not r["reviewer"].get("identity") or not r["reviewer"].get("rationale"):
                errs.append(f"EV-006: human review result {r['assertion_id']} requires reviewer identity and rationale")
    return errs

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--kind",choices=["suite","run"],required=True);ap.add_argument("files",nargs="+");a=ap.parse_args()
    failed=False
    for f in a.files:
        doc=load(f);errs=validate_suite(doc) if a.kind=="suite" else validate_run(doc)
        if errs:
            failed=True;print(f"FAIL {f}");[print(f"  {e}") for e in errs]
        else:print(f"PASS {f}")
    return 1 if failed else 0
if __name__=="__main__":sys.exit(main())
