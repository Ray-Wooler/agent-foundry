# ADR-0007 — Deterministic Runtime Authority Resolver Core

Status: PROPOSED

## Context

ADR-0006 established the Contextual Authority Contract (CAC) before runtime enforcement. The next bounded gate is to make contextual least-privilege resolution executable without prematurely bundling token issuance, credential brokering, connector enforcement or automated approval.

The resolver is part of the trusted control plane. The model may propose an execution plan and its required conceptual capabilities, but the model must not decide which authority it receives.

## Decision

Implement a deterministic, side-effect-free Authority Resolver core as `@agent-foundry/authority`.

Inputs are:

- a conforming CAC role hierarchy;
- task and plan identity;
- required capabilities derived from the execution plan;
- reusable authorization evidence;
- current time and optional session identity;
- whether untrusted context has been consumed;
- previously active contextual roles for replanning;
- an optional delegation capability ceiling.

Outputs are:

- `ALLOW`, `REQUIRES_APPROVAL`, or `DENY`;
- the deterministic minimum sufficient role set;
- selected effective capabilities;
- required approval roles;
- immutable decision evidence;
- a deterministic SHA-256 decision identifier.

The least-privilege selector minimizes, in order:

1. capabilities beyond those required by the plan;
2. number of selected roles;
3. lexical role identity as a deterministic tie-breaker.

Role inheritance contributes inherited capabilities and cyclic hierarchies fail closed. Exact subset search is bounded to 20 candidate roles in this first executable core; exceeding that bound fails closed rather than permitting unbounded combinatorial work.

## Authorization semantics

`ALLOW_TASK` is valid only for its task and before expiry.

`ALLOW_SESSION` is valid only for its session and before expiry.

`AUTHORIZE_ROLE` is reusable authorization but does not mean the role is globally active.

A selected role with no applicable authorization produces `REQUIRES_APPROVAL`. A broader reusable authorization may satisfy a narrower selected role when the selected role's effective capability set is a subset of the authorized role.

An applicable `DENY` blocks the denied role and any broader selected role that contains its effective capability set; denying a broader role does not implicitly deny narrower roles.

After untrusted context has been consumed, any expansion beyond the capabilities of the previously active role set produces `REQUIRES_APPROVAL`, even where reusable authorization exists.

A child resolution that exceeds a supplied parent/delegation capability ceiling is denied.

## Evidence

Every decision records the resolver version, CAC digest, evaluation timestamp, task/plan/session identity, required capabilities, selected roles and capabilities, prior active capability boundary, supporting and denying authorization references, expired authorizations, the delegation ceiling and any delegation violations, untrusted-context state, expansion state and reasons.

The decision ID is the SHA-256 digest of canonical decision evidence, binding the result to the authority records and CAC used for the decision.

## Explicit non-decisions

This gate does not implement:

- capability-token signing or issuance;
- Policy Enforcement Point / invocation interception;
- credential brokering;
- OAuth scope acquisition;
- approval UI or persistence;
- automatic approval policy;
- argument/resource enforcement;
- budgets and quota enforcement;
- database persistence of resolver decisions.

Those are subsequent gates.

## Security properties

- The resolver is deterministic and contains no model call.
- Missing capabilities fail closed.
- Expired/task/session-mismatched authorization cannot activate authority.
- Replanning after untrusted context cannot silently expand authority.
- Delegation cannot exceed its supplied parent capability ceiling.
- Contract cycles fail closed.
- Resolution has no external side effects.
- Exact least-privilege search has a deterministic complexity bound and fails closed beyond it.

## Acceptance

This ADR becomes ACCEPTED when the package typechecks/builds, boundary/regression tests pass, exact-head CI succeeds, and independent review identifies no unresolved high-consequence defect.
