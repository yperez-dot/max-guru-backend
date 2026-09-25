# Test note — CarePlus CareComplete H1019-150 crowns

**Sample agent Q:** “Are crowns covered on CareComplete H1019-150?” (with or without county)

**Expected Max answer shape:**

1. Yes — CarePlus CareComplete (HMO C-SNP) **H1019-150** covers crowns, **2 every 5 years**.
2. Bridges: Yes.
3. Cite THEI plan grid / CarePlus KB (same statewide SoB for Dade and Broward).
4. Then — and only then — SoB/EOC for CDT-level edge cases (prior auth, specific codes).
5. Do **not** answer only “$0 varies”, dump every CarePlus chronic, or send the agent to ChatGPT.

Automated checks: `npm test` (`services/planDataDental.test.js`) and `python3 scripts/test_dental_procedure_rows.py`.
