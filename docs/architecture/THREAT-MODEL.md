# Agent Foundry — Threat Model

Status: BASELINE
Date: 2026-10-02

## Security Objective

Agent Foundry transforms untrusted agent material into governed specifications and runtime artifacts without allowing imported content to acquire authority, escape tenant boundaries, forge provenance, or trigger unapproved side effects.

## Trust Boundaries

1. User / external source → Intake
2. Intake → PromptForge
3. PromptForge → APS candidate
4. Candidate → Evaluator
5. Evaluator → Release gate
6. Release → Compiler/package
7. Released package → FrankAI integration

Imported prompts, retrieved content, generated code, evaluation inputs and third-party metadata are untrusted until validated for their intended use.

## Primary Threats

- prompt/instruction injection through imported material
- cross-agent or cross-project instruction contamination
- authority or permission escalation
- unsafe tool invocation
- credential or secret exposure
- malicious generated code
- provenance or evidence forgery
- evaluation gaming
- stale or misleading evidence
- tenant/workspace data leakage
- licensing contamination
- unauthorised release/publication
- supply-chain compromise
- resource/cost exhaustion

## Mandatory Controls

- Treat imported/retrieved instructions as data, never governing authority.
- Separate capability, tool availability, permission and authority.
- Require applicable authority for consequential side effects.
- Preserve provenance from source through release.
- Separate evidence from claims and execution from verification.
- Sandbox future executable evaluations with explicit network/resource policy.
- Keep secrets outside agent specifications and generated artifacts.
- Make releases immutable and integrity-addressable.
- Record security-relevant actions in audit records.
- Fail closed when authority, provenance or release state is ambiguous.

## Initial Abuse Cases

### Prompt injection
A source prompt instructs PromptForge to ignore Foundry governance.
Expected: instruction remains source data and cannot alter system policy.

### Privilege escalation
An imported agent declares itself authorised to deploy production.
Expected: self-declared authority is ignored; authority derives from Foundry governance.

### Evidence forgery
An agent claims tests passed without execution evidence.
Expected: verification state cannot advance.

### Cross-project leakage
A transformation requests context belonging to another project/workspace.
Expected: access denied unless independently authorised.

### Release bypass
A candidate artifact is requested through the FrankAI publication interface.
Expected: only immutable RELEASED artifacts may cross the integration boundary.

## Deferred Analysis

Formal STRIDE-style enumeration, tenant isolation implementation, executable sandbox design, secrets architecture and supply-chain controls must be completed before the relevant implementation gate.
