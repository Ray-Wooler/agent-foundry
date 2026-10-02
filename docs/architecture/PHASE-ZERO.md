# Phase Zero — Architecture and Governed Execution

Status: IN PROGRESS
Baseline commit: 355b21a813d1bea45a8550e3c9264a8003d9cb2f
Working branch: feat/phase-zero-foundation

## Mission

Transform raw agent concepts and prompts into governed, portable, evaluated and versioned agent specifications that can be compiled for multiple AI runtimes and distributed independently or registered with FrankAI.

## Product Loop

INGEST → ANALYSE → RE-ENGINEER → SPECIFY (APS) → VALIDATE → EVALUATE → COMPILE → CERTIFY → PACKAGE → PUBLISH

## Bounded Contexts

1. Intake — source prompts, requirements, provenance.
2. PromptForge — analysis, defect detection and transformation.
3. APS — canonical specifications, validation and extensions.
4. Evaluation — behavioural, adversarial and conformance testing.
5. Compiler — runtime generation and target adapters.
6. Release — versions, certification, packaging and licensing.
7. FrankAI Integration — controlled publication of released artifacts.

## V1 Architecture

Use a modular monolith. Do not introduce microservices without an accepted ADR.

Repository is authoritative for deployable implementation and technical specifications. Persistent application state belongs in the database; source/generated/evaluation artifacts belong in controlled object storage where required.

## V1 Exclusions

- public marketplace
- arbitrary third-party plugins
- autonomous production deployment
- user-authored executable evaluator code
- microservices
- billing engine
- enterprise SSO
- community ratings
- fully autonomous certification

## Gates

- G0 Repository Authority
- G1 Architecture
- G2 APS machine-validatable schema
- G3 Registry persistence
- G4 PromptForge transformation
- G5 Evaluation framework
- G6 Generic + OpenAI compilation
- G7 Immutable release packaging
- G8 FrankAI controlled integration

A gate passes only with recorded acceptance evidence.
