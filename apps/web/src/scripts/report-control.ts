/**
 * THE REPORT CONTROL — a small reusable island wiring a "Report" button that
 * reveals an inline reason picker (mirrors comments.ts's Reply/Edit
 * inline-reveal pattern) and POSTs to /api/report. Shared by comments.ts
 * (per-comment) and post-report.ts (the post itself) — same control, two
 * target shapes.
 *
 * ⚠️ SAFETY (PM ruling, endpoint/UI audit 2026-09-24): the acknowledgment
 * shown after a successful submit is IDENTICAL whether or not this report
 * tripped the auto-hide threshold, and whether or not it was a duplicate of
 * an earlier report from the same viewer. `POST /reports` already returns a
 * bare 201 with no body in every one of those cases (apps/api/src/routes/
 * reports.ts) — there is no threshold/duplicate state reaching this file to
 * leak. Do not add a branch here that reads response BODY content to say
 * anything more specific than "thanks" vs "something went wrong": doing so
 * would require the api to start telling the client whether the threshold
 * fired, which is the thing this control must never surface.
 */
const REASONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "hate", label: "Hate speech" },
  { value: "sexual", label: "Sexual content" },
  { value: "violence", label: "Violence" },
  { value: "ip_infringement", label: "Copyright / IP infringement" },
  { value: "other", label: "Other" },
];

type ReportTarget = { postId: string } | { commentId: string };

export function wireReportButton(
  container: HTMLElement,
  opts: { csrfToken: string; target: ReportTarget },
): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-ghost";
  btn.textContent = "Report";
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    btn.disabled = true;

    const form = document.createElement("span");
    form.className = "report-form";

    const select = document.createElement("select");
    for (const r of REASONS) {
      const option = document.createElement("option");
      option.value = r.value;
      option.textContent = r.label;
      select.appendChild(option);
    }

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn btn-primary";
    submit.textContent = "Submit report";

    const note = document.createElement("span");
    note.className = "report-note";

    submit.addEventListener("click", () => {
      submit.disabled = true;
      const body = {
        ...("postId" in opts.target ? { postId: opts.target.postId } : { commentId: opts.target.commentId }),
        reason: select.value,
      };
      void fetch("/api/report", {
        method: "POST",
        headers: { "content-type": "application/json", "X-CSRF-Token": opts.csrfToken },
        body: JSON.stringify(body),
      })
        .then((resp) => {
          // ⚠️ Same message on every outcome this control distinguishes —
          // see this file's header. Never inspect `resp` beyond `.ok`.
          note.textContent = resp.ok
            ? "Thanks — we've received your report."
            : "Something went wrong — try again.";
          select.hidden = true;
          submit.hidden = true;
        })
        .catch(() => {
          note.textContent = "Network error — try again.";
          submit.disabled = false;
        });
    });

    form.appendChild(select);
    form.appendChild(submit);
    form.appendChild(note);
    container.appendChild(form);
  });
  container.appendChild(btn);
}
