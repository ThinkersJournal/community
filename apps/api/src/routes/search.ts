/**
 * ANONYMOUS SEARCH (M2.4a). A /public/* read — no session, viewer-independent,
 * HYPERDRIVE_FRESH, response no-store (the /search PAGE is short-TTL edge-cached;
 * this api response is not). pg_trgm word-similarity fuzzy match over published
 * posts and onboarded people, offset-paginated with a hasMore sentinel.
 *
 * ⚠️ The `<%` filter expression MUST match the partial GIN index in migration
 * 0009 byte-for-byte, or Postgres falls back to a seq scan. `$1` is always a bind
 * param (the similarity operator makes %/_ literal — no escaping). The search runs
 * inside a BEGIN…COMMIT so `SET LOCAL pg_trgm.word_similarity_threshold` takes
 * effect (SET LOCAL is the only threshold mechanism that survives Hyperdrive
 * transaction-mode pooling — see src/db/client.ts).
 */
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";
import { PEOPLE_SQL, POSTS_SQL } from "./search-sql";

import {
  SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE, SEARCH_Q_MAX, SEARCH_Q_MIN,
} from "@thinkersjournal/shared";
import type { SearchPersonResult, SearchPostResult } from "@thinkersjournal/shared";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Pagination decision, extracted pure so every branch is unit-testable without a
 * DB: a `+1` sentinel row (rowCount > PAGE_SIZE) means there is another page, but
 * we never page past SEARCH_MAX_OFFSET (the deepest offset the pager itself emits).
 */
export function nextOffsetFor(rowCount: number, offset: number): number | null {
  const hasMore = rowCount > SEARCH_PAGE_SIZE;
  return hasMore && offset + SEARCH_PAGE_SIZE <= SEARCH_MAX_OFFSET
    ? offset + SEARCH_PAGE_SIZE
    : null;
}

export async function handlePublicSearch(
  request: Request, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const type = url.searchParams.get("type") ?? "posts";
  const offsetRaw = url.searchParams.get("offset");

  if (q.length < SEARCH_Q_MIN || q.length > SEARCH_Q_MAX) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["q"] });
  }
  if (type !== "posts" && type !== "people") {
    return errorResponse("INVALID_INPUT", 400, { fields: ["type"] });
  }
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(offset) || offset < 0 || offset > SEARCH_MAX_OFFSET) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["offset"] });
  }

  const limit = SEARCH_PAGE_SIZE + 1;
  const page = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    // One simple-query BEGIN sets the threshold for this transaction only.
    await c.query("BEGIN; SET LOCAL pg_trgm.word_similarity_threshold = 0.3");
    try {
      const { rows } =
        type === "posts"
          ? await c.query<SearchPostResult>(POSTS_SQL, [q, limit, offset])
          : await c.query<SearchPersonResult>(PEOPLE_SQL, [q, limit, offset]);
      await c.query("COMMIT");
      const results = rows.slice(0, SEARCH_PAGE_SIZE);
      const nextOffset = nextOffsetFor(rows.length, offset);
      return { results, nextOffset };
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });
  return json(page);
}
