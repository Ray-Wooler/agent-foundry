# ADR-0006 — Contextual Authority Contract Before Runtime Resolution

Status: ACCEPTED

## Context

Agent Foundry already separates capability, tool availability, permission, authority, execution and verification. That separation is necessary but does not fully describe task-active authority.

Research in Zhu et al., *MiniScope: Authorizing Agents with Least-Privilege Permissions* (arXiv:2512.11147v2, 6 Oct 2026) demonstrates a useful task-centric pattern: reusable user authorization is distinct from the least-privilege roles activated for the current task, and tool calls are checked against that contextual boundary.

Agent Foundry also needs stronger guarantees than a service-scope hierarchy alone can provide: multi-agent delegation, resource and argument constraints, expiry, credential isolation, evidence and certification gates.

## Decision

Add Contextual Authority Contract (CAC) v1.0 to APS v1.5-alpha before implementing a runtime Authority Resolver.

The specification layer will define:

- contextual least-privilege roles;
- inactive-by-default task/session activation;
- task/plan-bound expiring authority tokens as a runtime requirement;
- `ALLOW_TASK`, `ALLOW_SESSION`, `AUTHORIZE_ROLE` and `DENY` authorization semantics;
- mandatory reauthorization for authority expansion;
- mandatory human approval for expansion after untrusted context;
- fail-closed runtime enforcement;
- service-credential isolation;
- subset-only delegation;
- audit evidence requirements.

PromptForge may construct or propose the contract but cannot grant execution/delegation authority or bind runtime tools.

Agent Foundry certification readiness will reject authority-bearing APS documents that lack a conforming CAC.

## Explicit non-decision

This ADR does **not** implement:

- the runtime Authority Resolver;
- task capability token issuance;
- connector credential brokering;
- runtime policy enforcement;
- permission hierarchy mining;
- automatic authority approval.

Those are subsequent bounded implementation stages and must not be described as implemented until verified.

## Consequences

Positive:

- authority semantics become machine-validatable before runtime implementation;
- certification can reject under-specified authority-bearing agents;
- PromptForge gains a stable contract to target;
- future runtime work has an explicit interface and invariant set.

Costs:

- authority-bearing APS documents require additional specification;
- existing authority-bearing documents may require migration before certification;
- static validation cannot prove runtime compliance.

## Source-control boundary

The authoritative implementation is the `frankai-online/agent-foundry` repository. Changes are delivered through reviewed branches and CI evidence.
