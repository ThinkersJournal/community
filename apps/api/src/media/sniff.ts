/**
 * Magic-byte type sniffing for uploaded images — an ALLOWLIST of exactly four
 * formats.
 *
 * ⚠️ THIS IS THE SVG DEFENSE, AND NOTHING ELSE IS.
 * SVG is a SUPPORTED input format for Cloudflare Images: the binding will NOT
 * reject it — it does not resize SVG, it merely sanitizes it via svg-hush and
 * passes it through. An SVG can survive the entire pipeline. Do not delete this
 * check because "the Images binding validates the format"; it does not validate
 * the format WE need validated.
 *
 * ⚠️ AN ALLOWLIST, NEVER A DENYLIST. SVG has no magic number — it is XML, and it
 * legitimately begins with a BOM, whitespace, a comment, a DOCTYPE, or an XML
 * declaration in any combination. There is no byte prefix to deny. "Accept only
 * these four" rejects it by construction and needs no knowledge of it at all.
 *
 * ⚠️ HAND-ROLLED ON PURPOSE. `file-type` is a large dependency on a path that
 * handles hostile bytes, and it does not detect SVG anyway. Thirty lines with no
 * dependency is the smaller risk.
 *
 * ⚠️ WHAT THIS CANNOT DO. A signature answers "what does this claim to be",
 * never "what will a decoder do with it" — a JPEG-prefixed polyglot sniffs as
 * JPEG. The belt-and-braces is the FREE `env.IMAGES.info()` format cross-check
 * in src/routes/media.ts. Never rely on either alone.
 */

export type SniffedFormat = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Enough for every signature below (WebP's needs offset 8..12). */
export const SNIFF_HEADER_BYTES = 16;

function matchesAt(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const; // "GIF87a"
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const; // "GIF89a"
const RIFF = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF" at 0
const WEBP = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP" at 8 (4..8 is the size)

/** The sniffed format, or `null` — which callers MUST turn into a 415. */
export function sniffImageFormat(header: Uint8Array): SniffedFormat | null {
  if (matchesAt(header, JPEG)) return "image/jpeg";
  if (matchesAt(header, PNG)) return "image/png";
  if (matchesAt(header, GIF87A) || matchesAt(header, GIF89A)) return "image/gif";
  // Both halves required: the RIFF container is shared with WAV/AVI.
  if (matchesAt(header, RIFF) && matchesAt(header, WEBP, 8)) return "image/webp";
  return null;
}
