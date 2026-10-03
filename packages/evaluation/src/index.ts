export type EvaluationOutcome = "PASS" | "PARTIAL" | "FAIL" | "NOT_APPLICABLE" | "NOT_TESTED";

export type EvaluationAssertion = {
  assertion_id: string;
  type: "JSON_PATH" | "REGEX" | "EXACT" | "SEMANTIC" | "HUMAN_REVIEW" | "POLICY";
  required: boolean;
  expression?: string | null;
  expected?: unknown;
  rationale?: string;
};

export type EvaluationSuite = {
  suite_id: string;
  version: string;
  name: string;
  class: "CONFORMANCE" | "FUNCTIONAL" | "BOUNDARY" | "ADVERSARIAL" | "REGRESSION" | "OUTCOME";
  cases: Array<{
    case_id: string;
    name: string;
    input: unknown;
    assertions: EvaluationAssertion[];
  }>;
  policy: {
    required_outcome: "PASS" | "PARTIAL";
    allow_not_applicable?: boolean;
    allow_not_tested?: boolean;
  };
};

export type AssertionResult = {
  case_id: string;
  assertion_id: string;
  assertion_type: EvaluationAssertion["type"];
  required: boolean;
  outcome: EvaluationOutcome;
  evidence: string[];
  reviewer: null | { identity: string; role: string; rationale: string };
};

export type SuiteExecutionResult = {
  status: "COMPLETED" | "AWAITING_HUMAN";
  outcome: EvaluationOutcome;
  results: AssertionResult[];
  requiresHuman: boolean;
};

function jsonPath(subject: unknown, expression: string): unknown {
  if (!expression.startsWith("$.")) throw new Error(`unsupported JSON path: ${expression}`);
  const parts = expression.slice(2).split(".");
  let current: any = subject;
  for (const part of parts) {
    if (part === "length") {
      if (Array.isArray(current) || typeof current === "string") current = current.length;
      else throw new Error(`length not supported at ${expression}`);
    } else {
      if (current === null || typeof current !== "object" || !(part in current)) return undefined;
      current = current[part];
    }
  }
  return current;
}

function stable(value: unknown): string {
  return JSON.stringify(value, Object.keys(value && typeof value === "object" && !Array.isArray(value) ? value as object : {}).sort());
}

export function executeEvaluationSuite(
  suite: EvaluationSuite,
  canonicalAps: unknown,
): SuiteExecutionResult {
  const results: AssertionResult[] = [];
  let requiresHuman = false;

  for (const testCase of suite.cases) {
    for (const assertion of testCase.assertions) {
      if (assertion.type === "HUMAN_REVIEW") {
        requiresHuman = true;
        results.push({
          case_id: testCase.case_id,
          assertion_id: assertion.assertion_id,
          assertion_type: assertion.type,
          required: assertion.required,
          outcome: "NOT_TESTED",
          evidence: ["Human review required before this assertion can be completed."],
          reviewer: null,
        });
        continue;
      }

      if (assertion.type === "EXACT") {
        const expression = assertion.expression;
        if (!expression) throw new Error(`EXACT assertion ${assertion.assertion_id} requires expression`);
        const actual = jsonPath(canonicalAps, expression);
        const passed = JSON.stringify(actual) === JSON.stringify(assertion.expected);
        results.push({
          case_id: testCase.case_id,
          assertion_id: assertion.assertion_id,
          assertion_type: assertion.type,
          required: assertion.required,
          outcome: passed ? "PASS" : "FAIL",
          evidence: [`${expression}: expected=${JSON.stringify(assertion.expected)} actual=${JSON.stringify(actual)}`],
          reviewer: null,
        });
        continue;
      }

      throw new Error(`unsupported automated assertion type: ${assertion.type}`);
    }
  }

  const machineFailure = results.some((r) => r.required && r.outcome === "FAIL");
  if (machineFailure) {
    return { status: "COMPLETED", outcome: "FAIL", results, requiresHuman };
  }
  if (requiresHuman) {
    return { status: "AWAITING_HUMAN", outcome: "NOT_TESTED", results, requiresHuman: true };
  }
  return { status: "COMPLETED", outcome: "PASS", results, requiresHuman: false };
}

export function applyHumanReview(
  prior: AssertionResult[],
  reviewer: { identity: string; role: string; rationale: string },
  outcome: "PASS" | "PARTIAL" | "FAIL",
): AssertionResult[] {
  return prior.map((result) => result.assertion_type === "HUMAN_REVIEW"
    ? {
        ...result,
        outcome,
        evidence: [`Human review outcome: ${outcome}`],
        reviewer,
      }
    : result);
}

export function aggregateRequiredSuites(
  executions: Array<{ required: boolean; status: string; outcome: EvaluationOutcome | null }>,
): { complete: boolean; outcome: EvaluationOutcome | null; awaitingHuman: boolean } {
  const required = executions.filter((x) => x.required);
  if (!required.length) return { complete: false, outcome: null, awaitingHuman: false };
  if (required.some((x) => x.status === "AWAITING_HUMAN")) {
    return { complete: false, outcome: null, awaitingHuman: true };
  }
  if (required.some((x) => x.status !== "COMPLETED")) {
    return { complete: false, outcome: null, awaitingHuman: false };
  }
  if (required.some((x) => x.outcome === "FAIL")) return { complete: true, outcome: "FAIL", awaitingHuman: false };
  if (required.some((x) => x.outcome === "PARTIAL")) return { complete: true, outcome: "PARTIAL", awaitingHuman: false };
  if (required.every((x) => x.outcome === "PASS")) return { complete: true, outcome: "PASS", awaitingHuman: false };
  return { complete: true, outcome: "FAIL", awaitingHuman: false };
}
