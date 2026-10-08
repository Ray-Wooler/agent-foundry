import {
  assessContextualAuthorityContract,
  buildDefaultContextualAuthorityContract,
} from "../packages/domain/dist/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseAps() {
  return {
    aps_version: "1.5-alpha",
    capabilities: [
      { id: "inspect", description: "Inspect supplied data." },
    ],
    governance: {
      authority: {
        recommendation: ["assess"],
        execution: [],
        delegation: [],
        approval_required: [],
        prohibited: [],
      },
      contextual_authority: buildDefaultContextualAuthorityContract(),
    },
    operational: {
      tools: [],
      side_effects: [],
    },
  };
}

const advisory = baseAps();
let assessment = assessContextualAuthorityContract(advisory);
assert(assessment.present, "advisory APS should carry the CAC skeleton");
assert(assessment.eligible, `advisory CAC should be eligible: ${assessment.reasons.join("; ")}`);
assert(!assessment.required, "advisory-only APS should not require active contextual roles");

const missing = baseAps();
missing.governance.authority.execution = ["inspect_data"];
delete missing.governance.contextual_authority;
assessment = assessContextualAuthorityContract(missing);
assert(assessment.required, "execution authority must require CAC");
assert(!assessment.eligible, "authority-bearing APS without CAC must be ineligible");

const emptyRoles = baseAps();
emptyRoles.governance.authority.execution = ["inspect_data"];
assessment = assessContextualAuthorityContract(emptyRoles);
assert(!assessment.eligible, "authority-bearing APS with no contextual roles must be ineligible");
assert(assessment.reasons.some((reason) => reason.includes("at least one contextual role")), "empty-role failure reason must be explicit");

const valid = baseAps();
valid.governance.authority.execution = ["inspect_data"];
valid.governance.contextual_authority.roles = [
  { id: "reader", capabilities: ["inspect"], inherits: [] },
];
assessment = assessContextualAuthorityContract(valid);
assert(assessment.eligible, `valid authority-bearing CAC should be eligible: ${assessment.reasons.join("; ")}`);

const invalidCapability = structuredClone(valid);
invalidCapability.governance.contextual_authority.roles[0].capabilities.push("unknown-capability");
assessment = assessContextualAuthorityContract(invalidCapability);
assert(!assessment.eligible, "role references to undeclared capabilities must be ineligible");

const invalidExpansion = structuredClone(valid);
invalidExpansion.governance.contextual_authority.replanning.post_untrusted_context_expansion_requires_human_approval = false;
assessment = assessContextualAuthorityContract(invalidExpansion);
assert(!assessment.eligible, "post-untrusted authority expansion without human approval must be ineligible");

const cyclic = structuredClone(valid);
cyclic.governance.contextual_authority.roles = [
  { id: "reader", capabilities: ["inspect"], inherits: ["reviewer"] },
  { id: "reviewer", capabilities: ["inspect"], inherits: ["reader"] },
];
assessment = assessContextualAuthorityContract(cyclic);
assert(!assessment.eligible, "cyclic contextual role inheritance must be ineligible");

console.log(JSON.stringify({
  status: "PASS",
  cases: [
    "advisory CAC skeleton",
    "missing CAC",
    "authority-bearing empty roles",
    "valid authority-bearing CAC",
    "undeclared role capability",
    "post-untrusted expansion approval",
    "cyclic role hierarchy"
  ]
}, null, 2));
