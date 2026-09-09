# Decision record — does the NCMEC CyberTipline path need an XML parser?

**Status:** Decision procedure, run 2026-09-08. **Outcome: no security blocker found; the
dependency is NOT added yet, because nothing consumes it yet.**
**Author:** Community controller agent.

This document exists because a dependency decision was about to be made on reasoning rather than
measurement. The portfolio PM ruled that the parser be pinned by probes rather than argued about:
*"a proven-negative beats my reasoning."* It was run as a **decision procedure** whose permitted
outcomes included *do not use this parser*.

---

## 1. The question

The M4 CSAM module must talk to NCMEC's CyberTipline "ISP Web Services" API, which is XML over
HTTPS. `fast-xml-parser` was proposed. The question raised in review: **is attacker-influenced XML
reaching a general-purpose parser?**

## 2. Which side needs it — measured, not assumed

| Side | Needs a parser? |
|---|---|
| **BUILD** the CyberTipline report | **No.** We *emit* this document against a fixed schema. Building does not parse. There is in-tree precedent: `apps/web/src/lib/xml.ts` builds sitemap/RSS by concatenation with a hand-written escaper, and `apps/web` depends on `fast-xml-parser` **only in tests**, to validate that output. |
| **PARSE** NCMEC's response | **Only candidate — and it is the network-facing side.** One or two known fields (`reportId`) from an authenticated endpoint. |

So the convenient answer ("build only, therefore no hostile input") was **not** available. The
parser's only use is on the side the concern was actually about.

## 3. ⚠️ The measurement — and the control did NOT fire

Probed `fast-xml-parser@5.10.1` (the version already in the monorepo via `apps/web`), comparing a
**default (un-hardened) control** against the proposed hardening `{ processEntities: false }`:

| Vector | DEFAULT (control) | HARDENED |
|---|---|---|
| XXE — external entity referencing a local file | **throws** `External entities are not supported` | throws (identical) |
| billion-laughs — nested entity expansion | **no expansion**; `&lol5;` returned literally | no expansion (identical) |
| benign document | parses correctly | parses correctly |

**Both configurations behaved identically on every probe.**

### What that means, stated plainly

⚠️ **`processEntities: false` is NOT a security control for these vectors in 5.10.1.** Had this
shipped as "hardened config + a passing test," the test would have been **a guard that cannot
fail the defect it is named after** — it would have passed just as happily with the hardening
removed. That is the exact failure class this probe was demanded to rule out, and it was found in
*my own proposed mitigation*.

The library refuses these attacks **by construction**, not by configuration. The correct
conclusion is not "we hardened it" but "it does not have the capability."

## 4. Two further vectors, also measured

| Vector | Result |
|---|---|
| Deep nesting (1 000 / 10 000 / 50 000 / 200 000) | **throws** `Maximum nested tags exceeded` — a built-in depth guard, fires even at 1 000 |
| Large input | **linear**, not explosive: 78 KB → 84 ms · 781 KB → 771 ms · 3.9 MB → 2.65 s · 5 MB single text node → 636 ms |
| Realistic NCMEC-shaped response | 2 ms |

So the only remaining resource vector is **raw input size → CPU time, linearly.**

## 5. What IS load-bearing

Exactly one thing, and it is **ours, not the library's**:

> **A byte cap on the response body, enforced BEFORE parsing.**

That is a real control: remove it and a test of it fails. Unlike `processEntities: false`, it is
not decorative. It belongs in the NCMEC client when that client is built.

## 6. Decision

**No security blocker.** All three classic XML attack classes (external entities, entity
expansion, recursion depth) are refused by `fast-xml-parser@5.10.1` by construction, measured with
a control arm.

**But the dependency is NOT added in this change**, because:

1. **Nothing consumes it yet.** The NCMEC client does not exist; the CSAM design is not written.
   Adding a dependency ahead of its consumer is inventory, not progress.
2. ⚠️ **The general-parser-vs-narrow-extractor question is still undecidable**, and will remain so
   until a **real NCMEC response** can be inspected — namespaces, CDATA, attribute-vs-element, and
   error-envelope shape are all unknown. **ESP enrolment is submitted and awaiting NCMEC.** Writing
   a narrow extractor against documentation alone would risk the worst failure mode in this
   system: a mis-extract that records a **legally required report as filed when it was not**.
3. The security objection that motivated the gate is now **measured away**, so adding it later
   carries no unknown. The risk of deferring is zero; the risk of guessing the wire format is not.

**What changes when the parser does land:** the probes in §7 become a **version-pinned
characterization test** — an honest claim (*"5.10.1 refuses these; fail loudly if a future version
regresses or the parser is swapped"*), which is a different and truthful claim from *"our config
protects us."* Plus the §5 byte cap, with its own test.

## 7. Reproducing the measurement

Self-contained; requires only the monorepo's existing install.

```js
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire("<repo>/apps/web/package.json");
const { XMLParser } = require("fast-xml-parser");

const fileUrl = pathToFileURL("<a file containing a unique canary>").href;
const XXE = `<?xml version="1.0"?>
<!DOCTYPE r [ <!ENTITY xxe SYSTEM "${fileUrl}"> ]>
<r><reportId>&xxe;</reportId></r>`;

const ENT = ['<!ENTITY lol "lol">'];
for (let i = 1; i <= 5; i++) {
  const prev = i === 1 ? "&lol;" : `&lol${i - 1};`;
  ENT.push(`<!ENTITY lol${i} "${prev.repeat(10)}">`);
}
const BILLION = `<?xml version="1.0"?>
<!DOCTYPE lolz [ ${ENT.join("\n ")} ]>
<lolz><reportId>&lol5;</reportId></lolz>`;

// ⚠️ Run BOTH arms. Without the un-hardened arm, "no expansion" is
// indistinguishable from "the input was rejected for an unrelated reason" —
// and it is the arm that revealed the hardening to be inert.
for (const cfg of [{}, { processEntities: false }]) {
  // parse XXE, BILLION, and a benign document; compare across arms
}
```

Deep-nesting and size probes: `"<a>".repeat(d) + "x" + "</a>".repeat(d)` for depth, and
`` `<r>${"<i>v</i>".repeat(n)}</r>` `` for width.

## 8. What this procedure is really a record of

A mitigation was proposed on reasoning, and measurement showed it did nothing. The dependency is
fine; **the proposed control was the defect.** Recording it here means the next person to reach for
`processEntities: false` as a safety measure finds the measurement instead of repeating the
reasoning.
