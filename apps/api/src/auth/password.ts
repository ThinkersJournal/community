/**
 * Argon2id password hashing for the `api` Worker.
 *
 * Uses the openpgpjs `argon2id` package driven by STATICALLY-IMPORTED `.wasm`
 * modules. workerd forbids runtime `WebAssembly.compile()` of embedded bytes,
 * but permits `WebAssembly.instantiate(precompiledModule, imports)`. A static
 * `import mod from "*.wasm"` (bundled by wrangler as a `CompiledWasm` module)
 * yields an already-compiled `WebAssembly.Module`, which we instantiate inside
 * loaders handed to the package's `setupWasm(...)`.
 *
 * Hashes are stored as PHC strings:
 *   `$argon2id$v=19$m=<KiB>,t=<iter>,p=<lanes>$<b64(salt)>$<b64(digest)>`
 * using the standard base64 alphabet WITHOUT padding (Argon2 PHC convention).
 *
 * ⚠️ THE `argon2(...)` CALL IS SYNCHRONOUS, AND THAT IS LOAD-BEARING — NOT AN
 * INCIDENTAL DETAIL OF THE LIBRARY'S API. The WASM instance is memoized
 * (`getArgon2`) and therefore SHARED by every concurrent hash and verify in the
 * isolate, and so is its linear memory — the ~19MiB scratch buffer each
 * derivation scribbles over. Nothing here partitions that memory per caller. The
 * ONLY thing keeping two concurrent `hashPassword` calls from interleaving
 * inside that shared buffer is JavaScript's single-threaded event loop: the
 * `argon2()` call contains no `await`, so once it starts it runs to completion
 * before any other continuation can be scheduled. It is an accidental critical
 * section, held by the runtime rather than by any lock in this file.
 *
 * If that call ever becomes asynchronous — a library version that returns a
 * Promise, an `await` introduced inside it, a move to a worker/threaded build —
 * this file's correctness silently collapses: two overlapping signups would
 * interleave in one scratch buffer and corrupt each other's derivations,
 * producing garbage hashes (and, on the verify path, spurious failures) with no
 * error raised anywhere. The failure is data-dependent and load-dependent, so it
 * would pass every test in this repo and surface only under real concurrency.
 * Do not make it async without ALSO adding real serialization (a promise chain /
 * mutex around the shared instance) or a per-call instance.
 */
import setupWasm from "argon2id/lib/setup.js";
// Statically-imported, precompiled `WebAssembly.Module`s (bundled by wrangler).
import nonSimdWasm from "argon2id/dist/no-simd.wasm";
import simdWasm from "argon2id/dist/simd.wasm";

import type { computeHash } from "argon2id/lib/setup.js";

/**
 * OWASP-recommended Argon2id parameters (as of the current baseline).
 * These map to the library call as: parallelism→parallelism,
 * iterations→passes, memorySize→memorySize (KiB), hashLength→tagLength.
 */
export const CURRENT_ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456,
  hashLength: 32,
} as const;

const SALT_BYTES = 16;

/**
 * Wrap a precompiled `WebAssembly.Module` in a loader that returns a
 * `WebAssemblyInstantiatedSource` (`{ module, instance }`) — the shape the
 * package's `setupWasm` expects (it reads `.instance` off the result).
 * `WebAssembly.instantiate(module, imports)` returns a bare `Instance`, so we
 * re-wrap it together with the module.
 */
function moduleLoader(
  mod: WebAssembly.Module,
): (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  return async (imports) => {
    const instance = await WebAssembly.instantiate(mod, imports);
    return { module: mod, instance };
  };
}

/**
 * Lazily initialize (and memoize) the argon2id WASM instance. The heavy
 * `setupWasm` work — allocating WASM memory and instantiating a module — runs
 * exactly once; every hash reuses the resulting compute function.
 *
 * ⚠️ SUCCESS IS MEMOIZED; FAILURE IS NOT. Memoizing the PROMISE (rather than the
 * resolved value) is what gives the no-double-init property: concurrent callers
 * racing a cold isolate all await the SAME in-flight promise, so `setupWasm`
 * runs once no matter how many requests arrive at once. But that same memo
 * applied to a REJECTED promise would cache the failure for the isolate's whole
 * lifetime: one transient init error and every subsequent hash/verify rejects
 * forever, with no retry — an unrecoverable per-isolate outage (fail-closed, so
 * not a security hole, but an availability one that only a redeploy clears).
 * So the memo is cleared on rejection and the next caller retries from scratch.
 *
 * The `argon2Promise === attempt` guard makes the clear idempotent under a race:
 * it ensures a late rejection can only ever clear ITS OWN memo, never a newer
 * attempt a subsequent caller has already installed. The error still propagates
 * to everyone awaiting the failed attempt — `hashPassword` lets it surface, and
 * `verifyPassword`'s try/catch turns it into a `false`, both unchanged.
 */
let argon2Promise: Promise<computeHash> | undefined;
function getArgon2(): Promise<computeHash> {
  if (argon2Promise === undefined) {
    const attempt: Promise<computeHash> = setupWasm(
      moduleLoader(simdWasm),
      moduleLoader(nonSimdWasm),
    ).catch((err: unknown) => {
      if (argon2Promise === attempt) {
        argon2Promise = undefined;
      }
      throw err;
    });
    argon2Promise = attempt;
  }
  return argon2Promise;
}

/** Standard base64 encode WITHOUT padding (PHC convention). */
function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/=+$/, "");
}

/** Standard base64 decode, tolerant of missing padding. Throws on invalid input. */
function b64decode(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface ParsedPhc {
  memorySize: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  digest: Uint8Array;
}

// `$argon2id$v=19$m=<n>,t=<n>,p=<n>$<b64 salt>$<b64 digest>`
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;

/**
 * Parse a PHC-encoded argon2id hash. Returns `null` for any malformed, foreign,
 * or otherwise unparseable string — never throws.
 */
function parsePhc(hash: string): ParsedPhc | null {
  const match = PHC_PATTERN.exec(hash);
  if (match === null) {
    return null;
  }
  const [, m, t, p, saltB64, digestB64] = match;
  try {
    return {
      memorySize: Number(m),
      iterations: Number(t),
      parallelism: Number(p),
      salt: b64decode(saltB64!),
      digest: b64decode(digestB64!),
    };
  } catch {
    return null;
  }
}

/** Constant-time byte comparison — no early return on first mismatch. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Hash a password with the current Argon2id parameters and a fresh 16-byte
 * random salt. Returns a PHC-encoded string.
 */
export async function hashPassword(pw: string): Promise<string> {
  const argon2 = await getArgon2();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const password = new TextEncoder().encode(pw);

  const digest = argon2({
    password,
    salt,
    parallelism: CURRENT_ARGON2_PARAMS.parallelism,
    passes: CURRENT_ARGON2_PARAMS.iterations,
    memorySize: CURRENT_ARGON2_PARAMS.memorySize,
    tagLength: CURRENT_ARGON2_PARAMS.hashLength,
  });

  const { memorySize, iterations, parallelism } = CURRENT_ARGON2_PARAMS;
  return `$argon2id$v=19$m=${memorySize},t=${iterations},p=${parallelism}$${b64encode(
    salt,
  )}$${b64encode(digest)}`;
}

/**
 * Verify a password against a PHC-encoded argon2id hash. Re-derives with the
 * PARSED parameters and compares in constant time. Returns `false` (never
 * throws) for a malformed hash or on any derivation error.
 */
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  const parsed = parsePhc(hash);
  if (parsed === null) {
    return false;
  }

  try {
    const argon2 = await getArgon2();
    const derived = argon2({
      password: new TextEncoder().encode(pw),
      salt: parsed.salt,
      parallelism: parsed.parallelism,
      passes: parsed.iterations,
      memorySize: parsed.memorySize,
      tagLength: parsed.digest.length,
    });
    return constantTimeEqual(derived, parsed.digest);
  } catch {
    return false;
  }
}

/**
 * Whether a hash was produced with parameters weaker/different from the current
 * baseline and should be re-hashed on next successful login. Returns `true` for
 * an unparseable or foreign hash.
 */
export function needsRehash(hash: string): boolean {
  const parsed = parsePhc(hash);
  if (parsed === null) {
    return true;
  }
  return (
    parsed.memorySize !== CURRENT_ARGON2_PARAMS.memorySize ||
    parsed.iterations !== CURRENT_ARGON2_PARAMS.iterations ||
    parsed.parallelism !== CURRENT_ARGON2_PARAMS.parallelism
  );
}
