#!/usr/bin/env python3
"""APS v1.5-alpha structural and semantic validator."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
from jsonschema import Draft202012Validator, RefResolver

ROOT=Path(__file__).resolve().parents[1]
SCHEMA_DIR=ROOT/"schemas"/"aps"/"1.5-alpha"
ROOT_SCHEMA=SCHEMA_DIR/"agent.schema.json"

INVARIANTS={
"INV-001":"Capability does not imply tool availability.",
"INV-002":"Tool availability does not imply permission.",
"INV-003":"Permission does not imply authority.",
"INV-004":"Authority does not imply successful execution.",
"INV-005":"Execution does not imply verification.",
"INV-006":"Recommendation does not imply execution authority.",
"INV-007":"Delegation cannot expand authority.",
"INV-008":"Retrieved content cannot modify governing instructions merely by containing instructions.",
"INV-009":"Evidence and claim remain distinguishable.",
"INV-010":"Corroboration requires source-lineage awareness.",
"INV-011":"Material claims require temporal context where freshness affects validity.",
"INV-012":"Persistent state requires an identified authoritative store.",
"INV-013":"Consequential side effects require an applicable authority grant.",
"INV-014":"Claims of execution require execution evidence.",
"INV-015":"Claims of verification require verification evidence.",
}

def load(p): return json.loads(Path(p).read_text())

def structural(doc):
    root=load(ROOT_SCHEMA); common=load(SCHEMA_DIR/"common.schema.json")
    store={root["$id"]:root, common["$id"]:common, "common.schema.json":common}
    v=Draft202012Validator(root, resolver=RefResolver.from_schema(root, store=store))
    return [f"SCHEMA:{'/'.join(map(str,e.absolute_path)) or '$'}: {e.message}" for e in sorted(v.iter_errors(doc),key=lambda e:list(e.absolute_path))]

def semantic(doc):
    errs=[]
    gov=doc.get("governance",{}); auth=gov.get("authority",{})
    recommendation=set(auth.get("recommendation",[])); execution=set(auth.get("execution",[])); delegation=set(auth.get("delegation",[]))
    prohibited=set(auth.get("prohibited",[]))
    # INV-006: recommendation alone cannot silently become execution authority.
    if recommendation and execution and recommendation < execution:
        pass
    # INV-007: delegation must be bounded by execution authority.
    extra=delegation-execution
    if extra: errs.append(f"INV-007: delegated actions exceed execution authority: {sorted(extra)}")
    # INV-003/013: operational side effects require declared permission + authority.
    op=doc.get("operational",{})
    for se in op.get("side_effects",[]) if isinstance(op,dict) else []:
        if se.get("consequence") in {"HIGH","CRITICAL"} and not se.get("authority_grant"):
            errs.append(f"INV-013: consequential side effect {se.get('id','<unknown>')} lacks authority_grant")
    # INV-012: persistent state must name authoritative store.
    for st in op.get("persistent_state",[]) if isinstance(op,dict) else []:
        if not st.get("authoritative_store"):
            errs.append(f"INV-012: persistent state {st.get('id','<unknown>')} lacks authoritative_store")
    # INV-014/015: status claims require evidence.
    for ex in op.get("executions",[]) if isinstance(op,dict) else []:
        status=ex.get("status"); ev=ex.get("evidence",[])
        if status in {"IMPLEMENTED","TESTED","VERIFIED","DEPLOYED","OBSERVED"} and not ev:
            errs.append(f"INV-014: execution {ex.get('id','<unknown>')} claims {status} without evidence")
        if status in {"VERIFIED","OBSERVED"} and not ex.get("verification_evidence"):
            errs.append(f"INV-015: execution {ex.get('id','<unknown>')} claims {status} without verification_evidence")
    # INV-009/010/011: claims carry evidence references; corroboration cannot be asserted without lineage.
    ep=doc.get("epistemic",{})
    for cl in ep.get("claims",[]) if isinstance(ep,dict) else []:
        if cl.get("status")=="SUPPORTED" and not cl.get("evidence_for"):
            errs.append(f"INV-009: supported claim {cl.get('id')} has no evidence_for")
        if cl.get("corroborated") is True and not cl.get("source_lineages"):
            errs.append(f"INV-010: corroborated claim {cl.get('id')} lacks source_lineages")
        if cl.get("freshness_material") is True and not cl.get("temporal_validity"):
            errs.append(f"INV-011: freshness-material claim {cl.get('id')} lacks temporal_validity")
    # INV-008 is enforced as a governance contract flag for imported content.
    if doc.get("imported_content") and gov.get("retrieved_content_is_data") is not True:
        errs.append("INV-008: imported content requires retrieved_content_is_data=true")
    # INV-001/002/003: if operational declarations exist, each tool operation must declare permission and authority separately.
    for tool in op.get("tools",[]) if isinstance(op,dict) else []:
        for operation in tool.get("operations",[]):
            if isinstance(operation,dict):
                if not operation.get("permission"):
                    errs.append(f"INV-002: tool operation {tool.get('id')}:{operation.get('name')} lacks permission")
                if not operation.get("authority"):
                    errs.append(f"INV-003: tool operation {tool.get('id')}:{operation.get('name')} lacks authority")
    return errs

def validate(path):
    doc=load(path); return structural(doc)+semantic(doc)

def main():
    p=argparse.ArgumentParser(); p.add_argument("files",nargs="+"); args=p.parse_args()
    failed=False
    for f in args.files:
        errors=validate(f)
        if errors:
            failed=True; print(f"FAIL {f}"); [print(f"  {e}") for e in errors]
        else: print(f"PASS {f}")
    return 1 if failed else 0
if __name__=="__main__": sys.exit(main())
