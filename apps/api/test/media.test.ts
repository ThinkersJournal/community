import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import worker from "../src";
import { withClient } from "../src/db/client";
import { MAX_UPLOAD_BYTES, MEDIA_QUOTA_BYTES } from "../src/routes/media";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";
import {
  oversizeBytes,
  pixelBombPng,
  PNG_1X1,
  SVG_BYTES,
  TEXT_BYTES,
} from "./fixtures/images";

import type { Actor } from "./actor";

/**
 * Task 8 — `POST /media`, the transform-on-WRITE image pipeline.
 *
 * ⚠️ THIS FILE IS ABOUT THE PIPELINE, NOT ABOUT AUTH. The auth-shaped
 * assertions (no Origin -> 403, no session -> 401) are covered STRUCTURALLY by
 * test/route-protection.test.ts, which enumerates src/routes.ts — `POST /media`
 * is held to them the moment it is registered, with no edit there.
 *
 * ⚠️ THE ACTOR IS BUILT WITH `createSession` DIRECTLY, NOT VIA `POST
 * /auth/signup`. That fixture — and the reasoning for it — now lives in
 * test/actor.ts, EXTRACTED THERE BY TASK 9 and imported rather than copied: this
 * suite, test/posts.test.ts and test/public-reads.test.ts all need the identical
 * verified-user-with-a-real-session, and the epoch subtlety in it is exactly the
 * kind of detail that rots in a duplicate. See that file's header.
 */

/** An origin in `checkOrigin`'s allowlist (src/auth/csrf.ts). */
const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function upload(body: BodyInit, actor: Actor): Request {
  return new Request("https://api.test/media", {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      Cookie: actor.cookie,
      "X-CSRF-Token": actor.csrfToken,
    },
    body,
  });
}

let actor: Actor;

beforeAll(async () => {
  actor = await createVerifiedActor();
});

afterAll(async () => {
  // `media.owner_id` is ON DELETE CASCADE, so deleting the users clears the rows.
  await deleteCreatedUsers();
});

describe("the happy path", () => {
  it("stores a content-addressed WebP and returns a CDN URL", async () => {
    const response = await fetchWorker(upload(PNG_1X1, actor));
    expect(response.status).toBe(201);
    // Belt-and-braces per the media research: nothing we serve may be
    // content-sniffed by a browser into a type we did not declare.
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const body = (await response.json()) as {
      id: string;
      url: string;
      width: number;
      height: number;
      bytes: number;
    };
    // Content-addressed on the OUTPUT hash, with NO user id in the path:
    // content addressing dedupes across users; ownership belongs in Postgres.
    expect(body.url).toMatch(
      /^https:\/\/cdn\.thinkersjournal\.com\/media\/post\/[0-9a-f]{64}\.webp$/,
    );
    expect(body.id[14]).toBe("7"); // uuidv7 PK

    const key = new URL(body.url).pathname.slice(1);
    const stored = await env.MEDIA.get(key);
    expect(
      stored,
      "the R2 object named by the returned URL does not exist",
    ).not.toBeNull();
    expect(stored!.httpMetadata?.contentType).toBe("image/webp");
    // Immutable: the key IS the hash, so the bytes can never change under it.
    expect(stored!.httpMetadata?.cacheControl).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  /**
   * ⚠️ THE POLYGLOT DEFENSE, ASSERTED ON THE STORED BYTES. The uploaded PNG is
   * NOT what lands in R2 — a full decode + re-encode is what makes a payload
   * hidden in a metadata segment (or after EOI) impossible to smuggle through.
   * If a future change ever adds a pass-through/"already WebP, just store it"
   * fast path, this goes red.
   */
  it("stores RE-ENCODED WebP bytes — never the uploaded original", async () => {
    const response = await fetchWorker(upload(PNG_1X1, actor));
    const { url } = (await response.json()) as { url: string };
    const stored = await env.MEDIA.get(new URL(url).pathname.slice(1));
    const bytes = new Uint8Array(await stored!.arrayBuffer());

    // RIFF....WEBP — genuinely re-rasterized output, not the PNG we sent.
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WEBP");
    expect(bytes).not.toEqual(PNG_1X1);
  });

  it("writes a media row owned by the SESSION's user", async () => {
    const response = await fetchWorker(upload(PNG_1X1, actor));
    const { id } = (await response.json()) as { id: string };
    const ctx = createExecutionContext();
    const { rows } = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query("SELECT owner_id FROM media WHERE id = $1", [id]),
    );
    await waitOnExecutionContext(ctx);
    expect(rows[0]!.owner_id).toBe(actor.userId);
  });

  it("DEDUPES: the same image twice yields one R2 key and TWO rows", async () => {
    const a = (await (await fetchWorker(upload(PNG_1X1, actor))).json()) as {
      id: string;
      url: string;
    };
    const b = (await (await fetchWorker(upload(PNG_1X1, actor))).json()) as {
      id: string;
      url: string;
    };
    expect(b.url).toBe(a.url);
    expect(b.id).not.toBe(a.id);
  });
});

describe("the allowlist is the SVG defense", () => {
  it("rejects an SVG with 415", async () => {
    // ⚠️ The Images binding would ACCEPT this — SVG is a SUPPORTED input format.
    // Verified against the binding under miniflare: `IMAGES.info(<svg>)` returns
    // `{ format: "image/svg+xml" }` rather than throwing, and Cloudflare's own
    // generated types carry a dedicated `{ format: 'image/svg+xml' }` branch in
    // `ImageInfoResponse` for exactly that. Only the sniff stops it.
    const response = await fetchWorker(upload(SVG_BYTES, actor));
    expect(response.status).toBe(415);
    expect(((await response.json()) as { code: string }).code).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
  });

  it("rejects arbitrary bytes with 415", async () => {
    expect((await fetchWorker(upload(TEXT_BYTES, actor))).status).toBe(415);
  });

  it("rejects an EMPTY body with 415", async () => {
    expect((await fetchWorker(upload(new Uint8Array(0), actor))).status).toBe(
      415,
    );
  });

  it("ignores a LYING Content-Type", async () => {
    const request = new Request("https://api.test/media", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-type": "image/png", // the client says PNG; the bytes say SVG
      },
      body: SVG_BYTES,
    });
    // The bytes decide. Never the header, and never a filename.
    expect((await fetchWorker(request)).status).toBe(415);
  });

  /**
   * A file whose first 8 bytes are a REAL PNG signature but whose body is
   * garbage. The sniff says `image/png` — correctly, those really are PNG magic
   * bytes — and the decoder disagrees. Pins that we HARD-REJECT rather than
   * falling back to trusting the sniff, and that a decoder failure is a client
   * error (415), never a 500.
   */
  it("rejects PNG magic bytes over a non-decodable body with 415", async () => {
    const fakePng = new Uint8Array(512);
    fakePng.set(PNG_1X1.subarray(0, 8), 0);
    fakePng.fill(0x41, 8);
    expect((await fetchWorker(upload(fakePng, actor))).status).toBe(415);
  });
});

describe("the size cap is enforced while streaming", () => {
  it("rejects an oversize body with 413", async () => {
    const response = await fetchWorker(
      upload(oversizeBytes(MAX_UPLOAD_BYTES), actor),
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("does NOT trust Content-Length", async () => {
    // A lying (small) Content-Length must not buy a large body through: the cap
    // is counted from the bytes actually read.
    const request = new Request("https://api.test/media", {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        Cookie: actor.cookie,
        "X-CSRF-Token": actor.csrfToken,
        "content-length": "10",
      },
      body: oversizeBytes(MAX_UPLOAD_BYTES),
    });
    expect((await fetchWorker(request)).status).toBe(413);
  });
});

/**
 * ⚠️ THIS BLOCK PINS THE ROUTE'S *WIRING* OF THE BOUND, which the unit tests in
 * test/images.test.ts deliberately cannot: `exceedsPixelBound` can be perfect and
 * still never be CALLED. Deleting the guard from src/routes/media.ts leaves every
 * unit test green and reddens exactly these.
 */
describe("pixel bombs are rejected on DECLARED dimensions", () => {
  it("rejects a 65-byte PNG that declares 8000x8000 with 413", async () => {
    const bomb = pixelBombPng(8000, 8000); // 64MP, over the 50MP bound
    // ⚠️ The byte cap is NOT what stops this: the bomb is ~230,000x SMALLER than
    // MAX_UPLOAD_BYTES. Only the declared-dimension bound stands between a few
    // dozen bytes and a multi-gigabyte decode.
    expect(bomb.byteLength).toBeLessThan(200);

    const response = await fetchWorker(upload(bomb, actor));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("ACCEPTS an image of the same shape that is UNDER the bound", async () => {
    // The other side of the boundary, so the case above proves the BOUND fired
    // and not merely "this crafted fixture is rejected somehow". 4MP.
    const ok = pixelBombPng(2000, 2000);
    expect((await fetchWorker(upload(ok, actor))).status).not.toBe(413);
  });
});

describe("quota", () => {
  it("rejects an upload once the owner is over quota, BEFORE transforming", async () => {
    // A DEDICATED actor: seeding the shared one's quota would leak into every
    // case above depending on declaration order.
    const broke = await createVerifiedActor();

    // Seed the quota directly — synthesising 100MB of real uploads would test
    // the test harness, not the route.
    const ctx = createExecutionContext();
    await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
      c.query(
        "INSERT INTO media (owner_id, r2_key, sha256, bytes, width, height) VALUES ($1,'seed','seed',$2,1,1)",
        [broke.userId, MEDIA_QUOTA_BYTES],
      ),
    );
    await waitOnExecutionContext(ctx);

    const response = await fetchWorker(upload(PNG_1X1, broke));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      "QUOTA_EXCEEDED",
    );
  });

  it("does not count ANOTHER user's uploads against you", async () => {
    // The quota sum must be scoped by owner_id — a global `sum(bytes)` would
    // pass every assertion above and lock every user out once anyone filled up.
    const fresh = await createVerifiedActor();
    expect((await fetchWorker(upload(PNG_1X1, fresh))).status).toBe(201);
  });
});
