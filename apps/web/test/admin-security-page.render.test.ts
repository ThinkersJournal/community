import { ACCESS_JWT_HEADER } from "@thinkersjournal/shared";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApiFetch } from "../src/lib/admin-api";
import Page from "../src/pages/admin/security.astro";

/**
 * RENDERED test of /admin/security (security-alerting PR 3): the real .astro
 * page goes through Astro's container API, with only `adminApiFetch` mocked
 * (the api itself is out of scope). Runs under the default web vitest config (Astro container API,
 * `cloudflare:workers` aliased to a Node stub).
