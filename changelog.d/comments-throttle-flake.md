kind: test: fix the comments PATCH throttle flake (#300)
---
`apps/api/test/comments.test.ts` "throttles rapid PATCHes" looped 12 times after one create (13 calls) against a limiter of 10 per 60 s. The emulated limiter uses fixed wall-clock windows, so a window boundary inside those calls reset the count and no 429 appeared. The loop now allows 25 PATCHes, which cannot fit in one window of 10 or in two (20). Test only; no production code changed.
