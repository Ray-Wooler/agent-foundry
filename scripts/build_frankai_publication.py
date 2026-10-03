#!/usr/bin/env python3
"""Build FrankAI publication payload from a verified Foundry release manifest."""
from __future__ import annotations
import argparse,json,sys
from pathlib import Path

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--release-manifest",required=True)
    ap.add_argument("--aps",required=True)
    ap.add_argument("--out",required=True)
    a=ap.parse_args()
    rel=json.loads(Path(a.release_manifest).read_text())
    aps=json.loads(Path(a.aps).read_text())
    if rel.get("status")!="RELEASED":
        print("integration blocked: release status is not RELEASED",file=sys.stderr); return 2
    if rel.get("rights_status") not in {"VERIFIED","RESTRICTED"}:
        print("integration blocked: rights state does not permit publication",file=sys.stderr); return 3
    evals=rel.get("evaluations",[])
    if not evals or any(x.get("outcome")!="PASS" for x in evals):
        print("integration blocked: release evaluation outcome is not PASS",file=sys.stderr); return 4
    targets=[]
    for art in rel.get("artifacts",[]):
        if art.get("type")=="RUNTIME":
            name=Path(art["path"]).stem
            if name in {"generic","openai"} and name not in targets: targets.append(name)
    if not targets:
        print("integration blocked: no supported runtime targets",file=sys.stderr); return 5
    payload={
      "contract_version":"1.0",
      "release":{"release_id":rel["release_id"],"release_version":rel["release_version"],"status":rel["status"]},
      "agent":{"id":rel["agent"]["id"],"version":rel["agent"]["version"]},
      "aps_version":rel["aps_version"],
      "package_sha256":rel["package_sha256"],
      "runtime_targets":sorted(targets),
      "capabilities":[c["id"] for c in aps.get("capabilities",[])],
      "evaluation":{"required_outcome":"PASS","observed_outcome":"PASS","run_ids":[x["run_id"] for x in evals]},
      "rights_status":rel["rights_status"],
      "published_at":"2026-10-03T06:00:00Z"
    }
    Path(a.out).parent.mkdir(parents=True,exist_ok=True)
    Path(a.out).write_text(json.dumps(payload,indent=2)+"\n")
    print(json.dumps(payload))
    return 0
if __name__=="__main__":sys.exit(main())
