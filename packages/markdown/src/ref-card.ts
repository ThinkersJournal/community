// SPDX-License-Identifier: MIT OR Apache-2.0
/** STUB (red-first commit): the real card renderer lands in the next commit. */
export type RefCardImage =
  | { storage: "remote"; url: string; alt?: string; width?: number; height?: number }
  | { storage: "stored"; key: string; alt?: string; width: number; height: number };

export interface RefCardStatus {
  label: "changed" | "resolved" | "gone";
  asOf?: string;
}

export interface RefCard {
  kind: string;
  deepLink: string;
  title: string;
  description?: string;
  siteName?: string;
  image?: RefCardImage;
  status?: RefCardStatus;
}

export type RefMap = ReadonlyMap<string, RefCard | null>;

export function renderRefCard(_card: RefCard | null): string {
  return "";
}
