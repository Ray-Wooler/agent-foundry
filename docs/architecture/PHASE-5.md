# Phase 5 — Certification Authority & Release Approval

Status: IN PROGRESS

## Objective

Introduce actual certification authority, immutable certification evidence, controlled release approval, and explicit separation between certification, packaging, publication and FrankAI registration.

## Flow

```text
EVALUATED + PASS + readiness ELIGIBLE
                |
                v
       Certification Authority
          /             \
      CERTIFY           DENY
         |                |
         v                v
     CERTIFIED         EVALUATED
         |
         v
      Release Approval
        /       \
    APPROVE     DENY
       |          |
       v          v
 release ELIGIBLE  blocked
       |
       v
   Packaging
       |
       v
   Publication
       |
       v
 FrankAI Registration
```

## Key Boundaries

- PASS evaluation is not certification;
- readiness ELIGIBLE is not certification;
- certification is not release approval;
- release approval is not packaging;
- packaging is not publication;
- publication is not FrankAI registration;
- release approval snapshots rights state;
- only OWNER/ADMIN authority may certify or approve release;
- AgentVersion remains CERTIFIED while later release stages use separate records.
