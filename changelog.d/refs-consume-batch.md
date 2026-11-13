kind: M3.2c-3b reference-refresh queue consumer logic
---
Adds `apps/api/src/references/refresh-consumer.ts`: `consumeRefreshBatch` runs one refresh per distinct reference id in a Queue batch, acks every finished refresh (including unknown and throttled outcomes, which the runner already rescheduled), acks and drops a malformed body, and retries a message whose refresh threw. Pure logic with the queue and the runner injected; nothing is wired, so there is no deploy impact. Verified red-first (6 failing tests on CI before the implementation) in `apps/api/test/references-consumer.test.ts`.
