/**
 * THE BLOCK/UNBLOCK CONTROL — hydrates the profile page's SSR-hidden
 * `[data-block-btn]` for a signed-in, non-owner viewer. Cached HTML carries
 * no viewer state (same reasoning as social.ts); this reads live from
 * /api/blocks?status= and reveals Block or Unblock accordingly.
 *
 * ⚠️ SAFETY REQUIREMENT (design doc §2.1, docs/superpowers/specs/
 * 2026-09-02-m4-report-block-design.md) — block is INTERACTION-CONTROL, not
 * invisibility: a blocked user's public posts stay public and reachable
 * logged-out. A user reaching for block during harassment often believes it
 * makes them invisible; if the UI implies that and block does not deliver
 * it, the user makes safety decisions on a false model — worse than no
 * block at all. This binds the confirm copy below EXACTLY:
 *   WRONG "Block — they will no longer be able to see your posts."
 *   RIGHT "Block — they can't follow, comment, react, or reach you. Your
 *          public posts stay public and they may still be able to read them."
 * Do not shorten or "simplify" BLOCK_COPY without checking that design doc.
 *
 * Two-step confirm on BLOCK only (mirrors post-delete.ts's inline reveal) —
 * a real behavior change worth a pause. UNBLOCK is a single click, like
 * unfollow: reducing a restriction needs no confirmation, and the api
 * itself treats it as a plain idempotent-adjacent DELETE.
 */
const BLOCK_COPY =
  "Block — they can't follow, comment, react, or reach you. Your public posts stay public and they may still be able to read them.";

interface BlocksStatusResponse {
  blocked: string[];
  viewerLoggedIn: boolean;
  csrfToken: string | null;
  viewerId: string | null;
}

async function loadStatus(userId: string): Promise<BlocksStatusResponse> {
  const fallback: BlocksStatusResponse = {
    blocked: [],
    viewerLoggedIn: false,
    csrfToken: null,
    viewerId: null,
  };
  try {
    const resp = await fetch(`/api/blocks?status=${encodeURIComponent(userId)}`);
    if (!resp.ok) return fallback;
    return (await resp.json()) as BlocksStatusResponse;
  } catch {
    return fallback;
  }
}

function renderUnblockState(btn: HTMLButtonElement, csrfToken: string, blockedId: string): void {
  btn.textContent = "Unblock";
  btn.hidden = false;
  btn.onclick = () => {
    btn.disabled = true;
    void fetch("/api/unblock", {
      method: "POST",
      headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ blockedId }),
    })
      .then((resp) => {
        if (resp.ok) location.reload();
        else btn.disabled = false;
      })
      .catch(() => {
        btn.disabled = false;
      });
  };
}

function renderBlockState(btn: HTMLButtonElement, csrfToken: string, blockedId: string): void {
  btn.textContent = "Block";
  btn.hidden = false;
  btn.onclick = () => {
    btn.disabled = true;
    btn.hidden = true;

    const confirmRow = document.createElement("span");
    confirmRow.className = "block-confirm";

    const copy = document.createElement("p");
    copy.textContent = BLOCK_COPY;

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn-primary";
    confirmBtn.textContent = "Confirm block";
    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      void fetch("/api/block", {
        method: "POST",
        headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ blockedId }),
      })
        .then((resp) => {
          if (resp.ok) {
            location.reload();
            return;
          }
          confirmBtn.disabled = false;
        })
        .catch(() => {
          confirmBtn.disabled = false;
        });
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      confirmRow.remove();
      btn.disabled = false;
      btn.hidden = false;
    });

    confirmRow.appendChild(copy);
    confirmRow.appendChild(confirmBtn);
    confirmRow.appendChild(cancelBtn);
    btn.insertAdjacentElement("afterend", confirmRow);
  };
}

export function initBlockToggle(): void {
  const btn = document.querySelector<HTMLButtonElement>("[data-block-btn]");
  if (btn === null) return;
  const profileUserId = btn.dataset.userId ?? "";
  if (profileUserId === "") return;

  void loadStatus(profileUserId).then((status) => {
    // Not logged in, or viewing your own profile: no block affordance at
    // all — stays SSR-hidden. Mirrors social.ts's self-follow gate: no
    // listener attached either, not just visually hidden (same #82/.btn[hidden]
    // lesson — don't rely on CSS alone to make an affordance inert).
    if (!status.viewerLoggedIn || status.csrfToken === null || status.viewerId === profileUserId) {
      return;
    }
    const csrfToken = status.csrfToken;
    if (status.blocked.includes(profileUserId)) {
      renderUnblockState(btn, csrfToken, profileUserId);
    } else {
      renderBlockState(btn, csrfToken, profileUserId);
    }
  });
}
