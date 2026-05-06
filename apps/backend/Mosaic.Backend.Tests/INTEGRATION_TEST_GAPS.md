# Backend Integration Test Gaps

## 2026-05-06 B3+B4+B5 refresh

Reviewed controller-level integration coverage for manifest CRUD, sync, idempotency middleware, and tiered shard reads.

### Covered now

- ADR-022 finalization response contract: `Snapshots/manifest-finalize.contract.json`
- Album sync confirmation contract: `Snapshots/album-sync.contract.json`
- Manifest version monotonicity on repeated finalization commits
- Existing B2 tiered shard retrieval for own/shared/share-link album reads in `Controllers/PhotoTieredShardsContractTests.cs`
- Idempotency key+same-body replay and key+different-body `409` behavior in `Middleware/IdempotencyMiddlewareTests.cs`

### Remaining gaps

- The test corpus is still primarily controller + middleware integration over in-memory EF, not full `WebApplicationFactory` HTTP integration.
- PostgreSQL row-locking behavior (`FOR UPDATE`) is not exercised by the default backend test gate.
- Share-link tier filtering is contract-tested for response shape, but not yet tested through a complete anonymous grant + photo retrieval HTTP flow.
