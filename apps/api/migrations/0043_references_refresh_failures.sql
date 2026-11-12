-- Up Migration
-- Refresh backoff counter (M3.2c-1). ADDITIVE ONLY: one new column with a constant default, nothing existing is
-- touched, so the old code runs against it unchanged and it can be applied first.
--
-- refresh_failures counts consecutive refresh attempts that ended `unknown` (rate_limited, error, forbidden). The
-- runner turns it into the next retry time (references/refresh-schedule.ts retryAt) and resets it to 0 on any
-- definitive result. NOT NULL DEFAULT 0 is a metadata-only change on a table this size.
ALTER TABLE "references" ADD COLUMN refresh_failures integer NOT NULL DEFAULT 0;

-- Down Migration
-- Drops the counter. A down migration is never automated (docs/runbooks/deploy.md).
ALTER TABLE "references" DROP COLUMN IF EXISTS refresh_failures;
