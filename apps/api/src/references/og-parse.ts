// SPDX-License-Identifier: MIT OR Apache-2.0
// STUB (red-first commit): implemented in the next commit.
import type { ImageRef } from "@thinkersjournal/shared";

export interface OgFields {
  title?: string;
  description?: string;
  siteName?: string;
  canonicalUrl?: string;
  image?: ImageRef;
}

export function parseOpenGraph(_html: string, _finalUrl: string): OgFields {
  throw new Error("not implemented");
}
