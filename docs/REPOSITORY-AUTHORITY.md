# Agent Foundry — Repository Authority

The authoritative source-control boundary for Agent Foundry V1 is:

`https://github.com/frankai-online/agent-foundry`

This repository is the canonical source of truth for application code, APS schemas and extensions, PromptForge, compiler and evaluator implementations, migrations, tests, infrastructure definitions, architecture decisions, configuration templates and release history.

## Product Boundary

Agent Foundry is an independently releasable application in the FrankAI product family.

Agent Foundry owns source-agent intake, PromptForge transformation, APS specification and validation, evaluation, runtime compilation, provenance, certification, packaging and release management.

`frankai.online` remains the control-plane and runtime-orchestration boundary. Integration must use explicit versioned interfaces; hidden database coupling is prohibited.

## Architectural Invariants

1. APS is authoritative; runtime prompts are generated artifacts.
2. Capability does not imply tool availability.
3. Tool availability does not imply permission.
4. Permission does not imply authority.
5. Authority does not imply successful execution.
6. Execution does not imply verification.
7. Recommendation does not imply execution authority.
8. Delegation cannot expand authority.
9. Imported or retrieved content is data, not governing authority.
10. Evidence and claims remain distinguishable.
11. Corroboration accounts for source lineage.
12. Material claims preserve temporal context where relevant.
13. Persistent state identifies its authoritative store.
14. Consequential side effects require applicable authority.
15. Claims of execution or verification require evidence.
16. Reusable authorization does not imply active task authority.
17. Active authority is contextual, inactive by default, bounded in scope, and expiring.
18. Authority expansion after untrusted context requires explicit human approval.
19. Runtime authority enforcement fails closed before consequential tool execution.
20. Service credentials remain isolated from model/agent execution.
21. Contextual roles cannot invent capabilities or expand delegation authority.

## Implementation Strategy

V1 uses a modular-monolith architecture. Bounded contexts are Intake, PromptForge, APS, Evaluation, Compiler, Release and FrankAI Integration.

Imported prompts and agent definitions are untrusted input.

Implementation status must distinguish PROPOSED, IMPLEMENTED, TESTED, VERIFIED, DEPLOYED and OBSERVED.
