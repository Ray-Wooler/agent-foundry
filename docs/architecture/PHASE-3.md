# Phase 3 — Governed Review & Promotion Workflow

Status: IN PROGRESS

## Objective

Convert REQUIRES_REVIEW into a governed human decision process with immutable reviewer identity, explicit lifecycle transitions and candidate revision lineage.

## Flow

```text
PromptForge Candidate
    DRAFT / REQUIRES_REVIEW
             |
             v
       Human Reviewer
      /      |       \
 APPROVE   REJECT   REQUEST_CHANGES
    |         |            |
    v         v            v
CANDIDATE   DRAFT     New queued revision
Eval READY  NOT_READY  Same Agent identity
Cert N/E    Cert N/E    New AgentVersion
Release N/E Release N/E
```

## Key Boundaries

- semantic approval does not equal evaluation success;
- evaluation readiness does not equal certification;
- certification does not equal release;
- request-changes does not mutate reviewed APS;
- rejection does not delete evidence;
- review identity and rationale are durable audit evidence.
