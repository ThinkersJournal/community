// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Ambient declaration so `tsc` accepts static `.wasm` imports. wrangler bundles
 * `**\/*.wasm` via a `CompiledWasm` module rule, exposing each file as an
 * already-compiled `WebAssembly.Module` default export.
 */
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
