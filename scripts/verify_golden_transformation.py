#!/usr/bin/env python3
"""Verify a golden PromptForge transformation against repository source and APS artifacts."""
from __future__ import annotations
import argparse, hashlib, json, subprocess, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def canonical_sha(obj):
    return hashlib.sha256(json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--source",required=True); ap.add_argument("--aps",required=True); ap.add_argument("--record",required=True)
    a=ap.parse_args()
    source=Path(a.source).read_bytes()
    aps=json.loads(Path(a.aps).read_text())
    rec=json.loads(Path(a.record).read_text())
    errors=[]
    source_sha=hashlib.sha256(source).hexdigest()
    aps_sha=canonical_sha(aps)
    if rec["source"]["sha256"]!=source_sha or rec["integrity"]["source_sha256"]!=source_sha:
        errors.append("GOLD-001 source digest does not match source artifact")
    if rec["candidate"]["sha256"]!=aps_sha or rec["integrity"]["candidate_sha256"]!=aps_sha:
        errors.append("GOLD-002 candidate digest does not match APS artifact")
    if rec["candidate"]["aps_document"]!=aps:
        errors.append("GOLD-003 embedded candidate differs from APS artifact")
    for cmd in [
      [sys.executable,str(ROOT/"scripts"/"validate_promptforge.py"),a.record],
      [sys.executable,str(ROOT/"scripts"/"validate_aps.py"),a.aps],
    ]:
        p=subprocess.run(cmd,cwd=ROOT)
        if p.returncode: errors.append(f"GOLD-004 validator failed: {' '.join(cmd)}")
    if errors:
        [print(e) for e in errors]; return 1
    print("PASS golden PromptForge transformation")
    print(f"source_sha256={source_sha}")
    print(f"candidate_sha256={aps_sha}")
    return 0
if __name__=="__main__": sys.exit(main())
