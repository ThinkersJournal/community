// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

/**
 * The `web` Worker: server-rendered Astro on Cloudflare, talking to the `api`
 * Worker over the `API` Service Binding (see wrangler.jsonc + src/lib/api.ts).
 *
 * ⚠️ VERSION NOTES — verified against the INSTALLED astro@7.0.9 /
 * @astrojs/cloudflare@14.1.3, not against tutorials, which are mostly still
 * written for adapter v9–v12 and are wrong here:
 *
 *   • `platformProxy: { enabled: true }` DOES NOT EXIST in adapter v14 and
 *     passing it is a config error. It was the v9-era mechanism for faking
 *     bindings inside a Node dev server. v14 is built on
 *     `@cloudflare/vite-plugin`, which runs `astro dev` inside REAL workerd, so
 *     bindings (including the `API` Service Binding) are the genuine article
 *     with no proxy to enable. The adapter's `Options` type is
 *     `Pick<PluginConfig, 'auxiliaryWorkers'|'configPath'|'inspectorPort'
 *     |'persistState'|'remoteBindings'>` + a few image/session keys — no
 *     `platformProxy` among them.
 *   • `configPath` defaults to this directory's `wrangler.jsonc`, so the
 *     bindings declared there are what dev and build both see. Not set
 *     explicitly — the default is already correct.
 */
export default defineConfig({
  // Every page here is server-rendered: they read the session cookie and call
  // the api per-request, so nothing may be baked at build time.
  output: "server",

  adapter: cloudflare({
    // ⚠️ NOT the default. Left unset, `imageService` is `"cloudflare-binding"`,
    // which makes the adapter declare an `images: { binding: "IMAGES" }` in the
    // Worker config for Cloudflare to auto-provision at deploy. This app has no
    // images at all in M0, so that would be live infrastructure supporting
    // nothing. `passthrough` serves images as-is and declares no binding.
    // Revisit if/when the app actually renders <Image>.
    imageService: "passthrough",
  }),

  // ⚠️ DELIBERATELY NEUTERED — DO NOT REMOVE THIS BLOCK.
  //
  // Global Constraint: sessions live in the `api` Worker's KV (opaque token ->
  // `sess:<sha256(token)>`, see apps/api/src/auth/session.ts). Astro must never
  // own session state, or we would have two competing session stores and two
  // cookies disagreeing about who is logged in.
  //
  // Astro 7 has NO `session: false` switch (`SessionSchema` is an object whose
  // `driver` is merely optional), and @astrojs/cloudflare@14 does this in its
  // `astro:config:setup` hook:
  //
  //     if (!session?.driver) { session = { driver: sessionDrivers.cloudflareKVBinding(...) } }
  //
  // i.e. leaving `session` unset does NOT mean "off" — it silently opts us into
  // a Cloudflare KV session store AND makes the adapter inject a `SESSION` KV
  // namespace binding into the Worker config, which Cloudflare would then
  // auto-provision at deploy. That is exactly the constraint we are told not to
  // violate.
  //
  // Setting ANY non-KV driver is what actually turns that off: the adapter gates
  // the binding on `usesCloudflareKVSessionDriver(session)`, which compares the
  // driver entrypoint against `unstorage/drivers/cloudflare-kv-binding`. The
  // `memory` driver does not match, so no KV binding is declared and no
  // namespace is provisioned (verified: the generated dist/server/wrangler.json
  // has `"kv_namespaces":[]`). It is also inert by construction — per-isolate,
  // non-persistent, and nothing in this app ever touches `Astro.session`.
  //
  // Spelled as a literal entrypoint rather than the tidier
  // `sessionDrivers.memory()` because Astro 7.0.9's `sessionDrivers` TYPE omits
  // `memory` (and `null`), even though its RUNTIME has them: the value is built
  // by filtering unstorage's `builtinDrivers`, but the shipped .d.ts lists only
  // a subset, so `sessionDrivers.memory()` is a ts(2339) error under
  // `astro check`. This object is precisely what that call returns at runtime
  // (`{ entrypoint: "unstorage/drivers/memory" }`) and matches Astro's own
  // `SessionDriverConfig`, so it type-checks without a suppression. Revisit if
  // the upstream types are fixed.
  session: {
    driver: { entrypoint: "unstorage/drivers/memory" },
  },
});
