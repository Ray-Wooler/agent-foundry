# Contextual Authority Contract (CAC) v1.0

Status: PROPOSED FOR APS v1.5-alpha

## Purpose

The Contextual Authority Contract separates what an agent can conceptually do from what it is authorized to do for the current task.

The contract adopts the task-centric least-privilege pattern described by Zhu et al., *MiniScope: Authorizing Agents with Least-Privilege Permissions* (arXiv:2512.11147v2, 6 Oct 2026), while extending it for Agent Foundry governance, multi-agent delegation, resource/argument constraints, audit evidence and certification.

MiniScope is a research input, not a runtime dependency.

## Core distinction

APS treats these states as distinct:

1. **Capability** — the agent is specified to perform a kind of work.
2. **Tool availability** — a runtime may expose a tool that could support that work.
3. **Permission** — an external service or platform permission may permit an operation.
4. **Reusable authorization** — a human or governing policy has approved a role for possible reuse.
5. **Contextual activation** — the minimum role set selected for this task/session.
6. **Execution** — an operation was actually attempted or performed.
7. **Verification** — evidence demonstrates the claimed execution/outcome.

No state implies the next state automatically.

## Canonical field

The contract is represented at:

`governance.contextual_authority`

The field is optional for backward-compatible non-authority-bearing APS documents. It becomes mandatory when the APS declares any execution or delegation authority, operational tool operation, or non-NONE side effect.

## Required contract

```json
{
  "contract_version": "1.0",
  "authority_model": "contextual_least_privilege",
  "roles": [],
  "activation": {
    "default": "INACTIVE",
    "scope": "TASK",
    "expiry_required": true
  },
  "authorization_modes": [
    "ALLOW_TASK",
    "ALLOW_SESSION",
    "AUTHORIZE_ROLE",
    "DENY"
  ],
  "task_token": {
    "task_bound": true,
    "plan_bound": true,
    "expiry_required": true
  },
  "runtime_enforcement": {
    "required": true,
    "fail_mode": "DENY",
    "credential_isolation_required": true
  },
  "replanning": {
    "authority_expansion_requires_reauthorization": true,
    "post_untrusted_context_expansion_requires_human_approval": true
  },
  "delegation": {
    "child_authority_must_be_subset": true
  },
  "audit": {
    "record_plan": true,
    "record_requested_roles": true,
    "record_approved_roles": true,
    "record_active_roles": true,
    "record_tool_invocations": true,
    "record_denials": true
  }
}
```

## Role semantics

Each role identifies a bounded set of declared APS capabilities. A role may inherit another role only when that parent role exists in the same contract. Role inheritance never creates a capability that is absent from the APS capability registry.

Roles are policy structure. They are not active permissions.

## Authorization semantics

- `ALLOW_TASK` authorizes the requested role for the current task only.
- `ALLOW_SESSION` authorizes reuse within the current bounded session, but the role remains inactive until contextually selected.
- `AUTHORIZE_ROLE` records reusable authorization. It does not activate the role.
- `DENY` refuses the requested authority.

Persistent/reusable authorization and active authority are therefore separate states.

## Replanning and untrusted context

A revised plan that remains inside active authority may continue without elevation.

Any revised plan that expands authority requires reauthorization.

Once the agent has consumed untrusted content — including retrieved documents, web content, email, tool responses, memory entries or child-agent output — any authority expansion requires explicit human approval even when a broader reusable role was previously authorized.

## Runtime boundary

The APS contract is normative specification. Static conformance does not implement enforcement.

A future runtime Authority Resolver and enforcement gateway must:

- resolve the minimum sufficient contextual role set from the execution plan;
- mint a short-lived task/plan-bound capability token;
- validate each tool invocation before it reaches a service;
- fail closed for missing, expired or out-of-scope authority;
- keep service credentials outside the model/agent boundary;
- enforce resource, argument and budget constraints when declared;
- emit audit evidence for authority decisions and consequential invocations.

Until that runtime exists and is independently verified, Agent Foundry must not claim that CAC runtime enforcement is implemented.

## Multi-agent delegation

For delegated execution:

`Authority(child) ⊆ Authority(parent)`

A parent agent may delegate only the sub-role required for the child task. A child cannot self-elevate. Additional authority returns through the normal resolver/approval path.

## Certification rule

Agent Foundry certification readiness must reject an authority-bearing APS when:

- the CAC is absent;
- the CAC violates its fail-closed, expiry, credential-isolation, replanning or audit requirements; or
- a contextual role references an undeclared capability or unknown parent role.

Certification checks specification completeness only. They do not prove runtime enforcement.

## Security boundary and limitation

CAC prevents authority expansion outside the declared contextual boundary. It does not by itself prove semantic correctness of an action already inside that boundary. Future runtime enforcement therefore also needs resource- and argument-level constraints, plan checks and budgets.
