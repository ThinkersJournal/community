// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * `loadRefCards`: what the render path reads (spec 2 and 6). It reads Postgres ONLY, the snapshot and the last
 * `live_state`, and never calls a source API (a render must stay cheap and must not be able to hit a third party).
 *
 * The map is keyed by token. A token is unique PER POST (not globally), so call this with the id of ONE post when the
 * map feeds `renderMarkdown`; with several ids, colliding tokens would overwrite each other.
 *
 * Snapshot and live_state are jsonb columns that a takedown, a future writer or a bug could leave in any shape, so they
 * are read defensively: anything that is not the expected shape is the "no longer available" card (null), never a throw
 * that would turn one bad row into a 500 for the whole post.
 */
import { defaultRegistry, type Registry } from "./registry";

import type { ImageRef, RefCard, SourceKind, StoredReference } from "@thinkersjournal/shared";
import type { Client } from "pg";

interface Row {
  token: string;
  kind: string;
  resource_key: string;
  snapshot: unknown;
  live_state: unknown;
  gone_at: Date | null;
}

interface CardText {
  title: string;
  description?: string;
  siteName?: string;
  image?: ImageRef;
}

type Status = NonNullable<RefCard["status"]>;

const KINDS: readonly SourceKind[] = ["web", "github", "gitlab"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function imageOf(value: unknown): ImageRef | undefined {
  if (!isRecord(value) || value["storage"] !== "remote" || typeof value["url"] !== "string") return undefined;
  const alt = optionalText(value["alt"]);
  return alt === undefined ? { storage: "remote", url: value["url"] } : { storage: "remote", url: value["url"], alt };
}

/** The snapshot's parts a card shows, or null if it is not a snapshot we can show. */
function textOf(snapshot: unknown): CardText | null {
  if (!isRecord(snapshot) || typeof snapshot["title"] !== "string") return null;
  const out: CardText = { title: snapshot["title"] };
  const description = optionalText(snapshot["description"]) ?? optionalText(snapshot["excerpt"]);
  const siteName = optionalText(snapshot["siteName"]);
  const image = imageOf(snapshot["image"]);
  if (description !== undefined) out.description = description;
  if (siteName !== undefined) out.siteName = siteName;
  if (image !== undefined) out.image = image;
  return out;
}

/**
 * The status label from the last observation. ACCESS is not DIFF: only a definite `gone`, or `forbidden` (it turned
 * private, so the snapshot stays and the card says it is no longer available), is shown as such; a rate-limited,
 * errored or not-modified observation says nothing about the content and shows no label.
 */
function statusOf(liveState: unknown, goneAt: Date | null): Status | undefined {
  if (goneAt !== null) return { label: "gone", asOf: goneAt.toISOString() };
  if (!isRecord(liveState)) return undefined;
  const observed = optionalText(liveState["observedAt"]);
  const labelled = (label: Status["label"]): Status => (observed === undefined ? { label } : { label, asOf: observed });
  if (liveState["access"] === "forbidden") return labelled("gone");
  const diff = liveState["diff"];
  return diff === "changed" || diff === "resolved" || diff === "gone" ? labelled(diff) : undefined;
}

/** The connector's view of a stored row. Only `web` exists, and its key is `web:<canonical url>`. */
function storedOf(row: Row, kind: SourceKind): StoredReference {
  const prefix = `${kind}:`;
  const canonicalUrl = row.resource_key.startsWith(prefix) ? row.resource_key.slice(prefix.length) : row.resource_key;
  return { kind, resourceKey: row.resource_key, canonicalUrl, snapshot: null, contentHash: "" };
}

function cardOf(row: Row, registry: Registry): RefCard | null {
  const kind = KINDS.find((k) => k === row.kind);
  const connector = kind === undefined ? undefined : registry.get(kind);
  const text = textOf(row.snapshot);
  if (kind === undefined || connector === undefined || text === null) return null;
  const card: RefCard = { kind, deepLink: connector.deepLink(storedOf(row, kind)), title: text.title };
  if (text.description !== undefined) card.description = text.description;
  if (text.siteName !== undefined) card.siteName = text.siteName;
  if (text.image !== undefined) card.image = text.image;
  const status = statusOf(row.live_state, row.gone_at);
  if (status !== undefined) card.status = status;
  return card;
}

export async function loadRefCards(
  db: Client,
  postIds: readonly string[],
  registry: Registry = defaultRegistry,
): Promise<Map<string, RefCard | null>> {
  const cards = new Map<string, RefCard | null>();
  if (postIds.length === 0) return cards;
  const { rows } = await db.query<Row>(
    `SELECT pr.token, r.kind, r.resource_key, r.snapshot, r.live_state, r.gone_at
       FROM post_references pr JOIN "references" r ON r.id = pr.reference_id
      WHERE pr.post_id = ANY($1::uuid[])
      ORDER BY pr.position, pr.id`,
    [postIds],
  );
  for (const row of rows) cards.set(row.token, cardOf(row, registry));
  return cards;
}
