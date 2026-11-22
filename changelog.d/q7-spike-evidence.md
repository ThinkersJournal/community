kind: docs: record the Q7 workerd spike evidence in ROADMAP S21
---
Records, in `docs/ROADMAP.md` row S21, what the 2026-10-10 local `wrangler dev` spike of the pdq `.wasm` showed: a 512x512 `si_pdq_dihedral` loop returned 200 with rising latency (up to 10268ms) and then the workerd runtime crashed twice. The cause is undiagnosed, so the CPU and memory fit stays UNPROVEN and Q7 must be re-run on the published crate. Documentation only; no code or behaviour change.
