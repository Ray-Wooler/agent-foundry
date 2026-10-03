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
