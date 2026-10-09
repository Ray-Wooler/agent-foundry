/** Deterministic PoC documentation gate. This does NOT verify measurements or grant execution authority. */
export type PocDecision = "GO" | "ITERATE" | "NO_GO";
export type PocEvidence = {
  apsVersion: "1.5-alpha";
  hypothesis: string;
  businessOutcome: string;
  baseline: string;
  method: string;
  environment: string;
  measurements: Array<{ metric: string; observed: number; threshold: number; direction: "at_least" | "at_most"; evidenceRef: string }>;
  provenance: string[];
  limitations: string[];
  rightsStatus: "VERIFIED" | "UNVERIFIED" | "RESTRICTED" | "PROHIBITED";
  executionAuthorized: boolean;
  executionObserved: boolean;
  independentReview: boolean;
};
export function evaluatePocEvidence(input: PocEvidence): { decision: PocDecision; findings: string[] } {
  const findings: string[] = [];
  if (input.apsVersion !== "1.5-alpha") findings.push("unsupported_aps_version");
  for (const key of ["hypothesis","businessOutcome","baseline","method","environment"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim()) findings.push("missing_" + key);
  }
  if (!Array.isArray(input.provenance) || !input.provenance.length || input.provenance.some(x => !x?.trim())) findings.push("missing_provenance");
  if (!Array.isArray(input.limitations) || !input.limitations.length || input.limitations.some(x => !x?.trim())) findings.push("missing_limitations");
  if (!Array.isArray(input.measurements) || !input.measurements.length) findings.push("missing_measurements");
  else for (const [index, metric] of input.measurements.entries()) {
    if (!metric.metric?.trim() || !metric.evidenceRef?.trim() || !Number.isFinite(metric.observed) || !Number.isFinite(metric.threshold) || !["at_least","at_most"].includes(metric.direction)) findings.push("invalid_metric_" + index);
    else if (metric.direction === "at_least" ? metric.observed < metric.threshold : metric.observed > metric.threshold) findings.push("threshold_failed_" + index);
  }
  if (input.rightsStatus !== "VERIFIED") findings.push("rights_not_verified");
  if (input.executionAuthorized !== true) findings.push("execution_not_authorized");
  if (input.executionObserved !== true) findings.push("execution_not_observed");
  if (input.independentReview !== true) findings.push("independent_review_missing");
  const fatal = findings.some(x => x.startsWith("threshold_failed_") || x === "rights_not_verified" && input.rightsStatus === "PROHIBITED");
  return { decision: fatal ? "NO_GO" : findings.length ? "ITERATE" : "GO", findings };
}
