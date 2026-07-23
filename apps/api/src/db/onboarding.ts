import { withClient } from "./client";

/**
 * true iff this user has chosen a durable handle (the M2.1 onboarding gate).
 * Extracted from routes/follows.ts when comments/reactions became the 3rd/4th
 * consumers. HYPERDRIVE_FRESH always: this is a permission read.
 */
export async function hasChosenUsername(
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<boolean> {
  return withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ username_chosen: boolean }>(
      "SELECT username_chosen FROM profiles WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.username_chosen === true;
  });
}
