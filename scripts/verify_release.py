#!/usr/bin/env python3
"""Verify immutable release package manifest and artifact digests."""
from __future__ import annotations
import argparse,hashlib,json,sys
from pathlib import Path
from jsonschema import Draft202012Validator
ROOT=Path(__file__).resolve().parents[1]
SCHEMA=ROOT/"schemas"/"release"/"1.0"/"manifest.schema.json"
def sha_bytes(b): return hashlib.sha256(b).hexdigest()
def main():
    ap=argparse.ArgumentParser();ap.add_argument("--package-dir",required=True);a=ap.parse_args()
    root=Path(a.package_dir); m=json.loads((root/"release.manifest.json").read_text()); errs=[]
    for e in Draft202012Validator(json.loads(SCHEMA.read_text())).iter_errors(m): errs.append(e.message)
    if m.get("rights_status")!="VERIFIED": errs.append("RL-001 distributable release requires VERIFIED rights")
    digests=[]
    for art in m.get("artifacts",[]):
        p=root/art["path"]
        if not p.exists(): errs.append(f"RL-002 missing artifact {art['path']}"); continue
        d=sha_bytes(p.read_bytes()); digests.append(d)
        if d!=art["sha256"]: errs.append(f"RL-003 digest mismatch {art['path']}")
    if digests and sha_bytes("".join(sorted(digests)).encode())!=m.get("package_sha256"):
        errs.append("RL-004 package digest mismatch")
    if any(e.get("outcome")!="PASS" for e in m.get("evaluations",[])): errs.append("RL-005 required evaluation not PASS")
    if errs:
        [print(x) for x in errs]; return 1
    print("PASS release verification"); return 0
if __name__=="__main__": sys.exit(main())
