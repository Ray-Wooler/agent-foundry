# Phase Zero Acceptance Matrix

Status: ACTIVE

| Gate | Criterion | Evidence | Status |
|---|---|---|---|
| G0 | Canonical private repository established | Ray-Wooler/agent-foundry | PASS |
| G0 | Default branch governed by active ruleset | Protect Main ruleset 24352789 | VERIFIED |
| G0 | Phase Zero work isolated from main | feat/phase-zero-foundation + PR #1 | PASS |
| G1 | Product boundary defined | ADR-0001 | PASS |
| G1 | V1 architecture style defined | ADR-0002 | PASS |
| G1 | APS authority defined | ADR-0003 | PASS |
| G1 | Immutable release boundary defined | ADR-0004 | PASS |
| G1 | Baseline threat model present | THREAT-MODEL.md | PASS |
| G2 | APS canonical layers documented | specification/APS-1.5-alpha/README.md | PASS |
| G2 | Root machine-readable schema exists | schemas/aps/1.5-alpha/agent.schema.json | PARTIAL |
| G2 | Reusable common definitions exist | common.schema.json | PARTIAL |
| G2 | Positive and negative fixtures exist | tests/fixtures/aps/1.5-alpha | PARTIAL |
| G2 | Automated schema validation executes in CI | .github/workflows/aps-conformance.yml + scripts/validate_aps.py | IMPLEMENTED / AWAITING CI EVIDENCE |
| G2 | All 15 APS invariants have machine-testable representation or documented validator rule | specification/APS-1.5-alpha/INVARIANTS.md | IMPLEMENTED |
| G3 | Registry persistence | pending | NOT STARTED |
| G4 | PromptForge transformation | pending | NOT STARTED |
| G5 | Evaluation framework | pending | NOT STARTED |
| G6 | Generic + OpenAI compilation | pending | NOT STARTED |
| G7 | Immutable release packaging | pending | NOT STARTED |
| G8 | FrankAI integration | pending | NOT STARTED |

## Merge Rule

PR #1 must remain unmerged while G1/G2 acceptance work identified for the Phase Zero foundation is incomplete. A PASS must be backed by inspectable repository evidence.
