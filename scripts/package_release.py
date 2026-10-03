#!/usr/bin/env python3
"""Build an immutable Agent Foundry release package from certified inputs."""
from __future__ import annotations
import argparse,hashlib,json,shutil,sys,tempfile
from pathlib import Path

def sha_bytes(b): return hashlib.sha256(b).hexdigest()
def copy_with_digest(src,dst):
    data=Path(src).read_bytes(); Path(dst).parent.mkdir(parents=True,exist_ok=True); Path(dst).write_bytes(data); return sha_bytes(data)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--agent-id",required=True)
    ap.add_argument("--agent-version",required=True)
    ap.add_argument("--release-version",required=True)
    ap.add_argument("--aps",required=True)
    ap.add_argument("--evaluation",required=True)
    ap.add_argument("--rights-status",required=True,choices=["VERIFIED","UNVERIFIED","RESTRICTED","PROHIBITED"])
    ap.add_argument("--runtime",action="append",default=[])
    ap.add_argument("--compilation-manifest",action="append",default=[])
    ap.add_argument("--provenance")
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()

    ev=json.loads(Path(args.evaluation).read_text())
    if ev.get("outcome")!="PASS":
        print("release blocked: required evaluation is not PASS",file=sys.stderr); return 2
    if args.rights_status!="VERIFIED":
        print(f"release blocked: rights_status={args.rights_status}",file=sys.stderr); return 3
    if not args.runtime:
        print("release blocked: at least one runtime artifact required",file=sys.stderr); return 4

    out=Path(args.out_dir)
    if out.exists(): shutil.rmtree(out)
    out.mkdir(parents=True)

    artifacts=[]
    aps_dst=out/"agent.aps.json"; artifacts.append({"path":"agent.aps.json","sha256":copy_with_digest(args.aps,aps_dst),"type":"APS"})
    ev_dst=out/"evaluation.json"; artifacts.append({"path":"evaluation.json","sha256":copy_with_digest(args.evaluation,ev_dst),"type":"EVALUATION"})
    if args.provenance:
        p=out/"provenance.json"; artifacts.append({"path":"provenance.json","sha256":copy_with_digest(args.provenance,p),"type":"PROVENANCE"})
    for i,src in enumerate(args.runtime):
        name=Path(src).name; p=out/"runtime"/name; artifacts.append({"path":f"runtime/{name}","sha256":copy_with_digest(src,p),"type":"RUNTIME"})
    for src in args.compilation_manifest:
        name=Path(src).name; p=out/"runtime"/name; artifacts.append({"path":f"runtime/{name}","sha256":copy_with_digest(src,p),"type":"COMPILATION_MANIFEST"})

    package_digest=sha_bytes("".join(sorted(a["sha256"] for a in artifacts)).encode())
    aps=json.loads(Path(args.aps).read_text())
    manifest={
      "release_id":f"{args.agent_id}@{args.release_version}",
      "agent":{"id":args.agent_id,"version":args.agent_version},
      "release_version":args.release_version,
      "aps_version":aps["aps_version"],
      "status":"RELEASED",
      "rights_status":args.rights_status,
      "artifacts":artifacts,
      "evaluations":[{"run_id":ev["run_id"],"outcome":ev["outcome"]}],
      "package_sha256":package_digest,
      "released_at":"2026-10-03T05:45:00Z"
    }
    (out/"release.manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    print(json.dumps(manifest))
    return 0
if __name__=="__main__": sys.exit(main())
