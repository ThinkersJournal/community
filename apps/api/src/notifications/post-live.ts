/**
 * PER-POST LIVE PUSH SEAM. Fires a content-free {type} nudge at a post's
 * PostLiveDO so every open post-page tab refetches. Same discipline as
 * notify() (create.ts): delivered via ctx.waitUntil (an unawaited DO RPC is
 * canceled once the Response returns), failure swallowed, NEVER throws / never
 * rolls back the triggering write. Callers gate on a REAL row change — a no-op
 * write must not push. Structural env/ctx for the same tsconfig reason as
 * NotifyEnv/NotifyCtx.
 */
interface PostLiveEnv {
  POST_LIVE: { getByName(id: string): { push(kind: "comment" | "reaction"): void } };
}
export interface PostLiveCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export function notifyPostLive(
  env: PostLiveEnv,
  ctx: PostLiveCtx,
  postId: string,
  kind: "comment" | "reaction",
): void {
  ctx.waitUntil(
    (async () => {
      try {
        await env.POST_LIVE.getByName(postId).push(kind);
      } catch (err) {
        console.error("post-live push failed", { kind, err });
      }
    })(),
  );
}
