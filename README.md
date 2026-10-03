# Agent Foundry

Agent Foundry is an independently releasable application within the FrankAI product family.

It transforms source agent material into governed APS specifications, evaluations, runtime artifacts, releases, and FrankAI publication payloads.

## Current architecture

```text
Web
  ↓
API
  ↓
PostgreSQL queue
  ↓
Worker
  ↓
Governed APS candidate
```

Phase Zero established APS, registry, PromptForge, evaluation, compilation, release packaging, and FrankAI integration governance.

Phase 1 adds the executable application foundation:

- `apps/web` — login, source intake, candidate review UI
- `apps/api` — sessions, workspace authorization, intake/status API
- `apps/worker` — queued transformation processing
- `packages/db` — PostgreSQL and migrations
- `packages/auth` — password hashing and opaque session tokens
- `packages/domain` — governed candidate construction

## Local development

Requirements:

- Node.js 22+
- pnpm 10.12.4
- PostgreSQL 16, or Docker Compose

```bash
cp .env.example .env
docker compose up -d postgres
set -a; . ./.env; set +a
corepack enable
corepack prepare pnpm@10.12.4 --activate
pnpm install
pnpm typecheck
pnpm build
pnpm db:migrate
```

Start the three processes in separate terminals:

```bash
set -a; . ./.env; set +a
pnpm --filter @agent-foundry/api start
```

```bash
set -a; . ./.env; set +a
pnpm --filter @agent-foundry/worker start
```

```bash
set -a; . ./.env; set +a
pnpm --filter @agent-foundry/web start
```

Then open `http://localhost:3000`.

The bootstrap account is controlled by `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`. Change the example password before using any persistent environment.

## Governance

The canonical repository is `git@github.com:Ray-Wooler/agent-foundry.git`.

Protected `main` requires the Phase Zero integrity checks. See:

- `docs/REPOSITORY-AUTHORITY.md`
- `docs/architecture/ACCEPTANCE-MATRIX.md`
- `docs/architecture/PHASE-1.md`
- `docs/architecture/PHASE-1-ACCEPTANCE.md`

A foundation candidate is intentionally conservative: no inferred capabilities, tool access, execution authority, or delegation authority are added before governed PromptForge review.

## Phase 2 PromptForge

PromptForge now supports a governed staged model-backed transformation pipeline:

```text
Source Prompt
  -> Intent Analysis
  -> Defect Analysis
  -> Capability Extraction
  -> Governance Construction
  -> Deterministic APS Builder
  -> Hard Governance Validation
  -> Reviewer Diff + Explanation
  -> DRAFT / REQUIRES_REVIEW
```

The model analyses and proposes. Deterministic application code owns authority-bearing APS fields. Model output cannot grant execution authority, delegation authority, runtime tool bindings, promotion, certification, or release.

For credentialed OpenAI execution:

```bash
PROMPTFORGE_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=...
```

CI uses the deterministic provider through the same engine contract and separately tests the OpenAI Responses API adapter against a local protocol mock.


## Phase 3 Review Governance

PromptForge candidates now enter an explicit human semantic-review workflow:

```text
DRAFT / REQUIRES_REVIEW
        |
        v
 Human semantic review
   /       |        \
APPROVE  REJECT  REQUEST_CHANGES
  |         |          |
  v         v          v
CANDIDATE  DRAFT   New DRAFT revision
Eval READY NOT_READY Same Agent identity
Cert N/E   Cert N/E New AgentVersion
Release N/E Release N/E Immutable lineage
```

Review records bind reviewer identity, workspace role, rationale and the exact candidate digest. They are immutable.

A semantic approval only makes the candidate eligible to enter evaluation. It does not certify or release the agent.

A request for changes never mutates the reviewed APS. It creates a new PromptForge transformation using the same immutable source artifact plus separately recorded reviewer guidance, producing a new AgentVersion under the same Agent registry identity.


## Phase 4 Evaluation Orchestration

Semantically approved candidates now enter an explicit evaluation lifecycle:

```text
CANDIDATE
   |
   v
Freeze required evaluation suites
   |
   v
VALIDATED
   |
   +--> deterministic machine suites
   |
   +--> human suites -> AWAITING_HUMAN
   |                     |
   |                     v
   |               reviewer evidence
   |                     |
   +---------------------+
   |
   v
Aggregate required outcomes
   |
   v
EVALUATED
   |
   +--> PASS -> separate certification-readiness review may mark ELIGIBLE
   |
   +--> FAIL -> NOT_ELIGIBLE
```

Evaluation completion and evaluation success are distinct. An AgentVersion becomes `EVALUATED` after the required plan completes even when the aggregate is FAIL.

A PASS aggregate does not automatically certify the agent. Certification eligibility requires a separate immutable human readiness decision, and Phase 4 still blocks direct transition to `CERTIFIED`.

Built-in Phase 4 suites:

- `core-governance-v1` — machine assertions over canonical APS boundaries;
- `human-semantic-quality-v1` — required human evaluation evidence.
