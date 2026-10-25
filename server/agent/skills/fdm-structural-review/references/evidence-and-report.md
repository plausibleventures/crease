# Evidence and report contract

## Evidence ladder

Use the lowest adequate level and state what it cannot prove:

1. `geometry` — dimensions and interfaces only.
2. `analytic-screening` — order-of-magnitude or simplified model.
3. `analytic-calculation` — applicable first-order model with traced inputs.
4. `fem-preliminary` — stated solver model without completed convergence evidence.
5. `fem-converged` — equilibrium, analytical comparison, and selected-QoI mesh study.
6. `coupon` — process-matched specimen evidence.
7. `physical-test` — assembly or part test under stated conditions.

Verification asks whether equations or solver models were solved correctly. Validation asks whether the model represents the manufactured part and service condition.

## Required report fields

Return a compact human report and, when useful, matching JSON:

```json
{
  "schema_version": "0.1",
  "report_type": "mechanical-strength-review",
  "claim_scope": "preliminary_design_check",
  "status": "calculated|warning|not_tested|escalate",
  "evidence_level": "analytic-screening",
  "requirements": {},
  "load_cases": [],
  "free_body_model": {},
  "failure_modes": [],
  "material_evidence": [],
  "assumptions": [],
  "model_basis": {},
  "results": [],
  "quality_checks": [],
  "untested_risks": [],
  "required_validation": []
}
```

Use `not_tested` rather than an invented number. A reported factor is only a factor against a named allowable for one failure mode; it is not a whole-part safety declaration.
