# CLAUDE.md

> **Mosaic** — A zero-knowledge encrypted photo gallery for personal use (≤50 users).
> The server **never** sees plaintext photos or metadata. All encryption happens client-side.

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `.\scripts\dev.ps1 start` | Start full dev stack (Windows) |
| `./scripts/dev.sh start` | Start full dev stack (Linux/Mac) |
| `cd libs/crypto && npm test` | Crypto unit tests |
| `cd apps/admin && npm run test:run` | Frontend unit tests |
| `dotnet test apps/backend/Mosaic.Backend.Tests` | Backend tests |
| `.\scripts\run-e2e-tests.ps1` | E2E tests (stack must be running) |

**URLs:** Frontend → http://localhost:5173 | Backend → http://localhost:5000

---

## Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | React 19, TypeScript, Vite 6, Web Workers, SQLite-WASM, libsodium |
| **Backend** | .NET 10, ASP.NET Core, EF Core, PostgreSQL, Tus uploads |
| **Crypto** | XChaCha20-Poly1305, Ed25519, Argon2id, HKDF-SHA256 |

---

## 🔐 Zero-Knowledge Invariants (NEVER VIOLATE)

1. **Server stores only encrypted blobs** — Never parse or inspect content
2. **All encryption/decryption is client-side** — Keys never touch the server
3. **24 random bytes per nonce** — Never reuse with the same key
4. **Call `sodium.memzero()`** — Wipe sensitive keys after use
5. **Never log key material** — No `console.log(privateKey)`

---

## Project Structure

```
libs/crypto/           # Shared TypeScript crypto library
apps/backend/          # .NET 10 API (ASP.NET Core)
apps/admin/            # React 19 frontend
  src/components/      # UI components by feature
  src/hooks/           # 22+ custom hooks
  src/workers/         # Web Workers (crypto, db, geo)
tests/e2e/             # Playwright E2E tests
docs/                  # Comprehensive documentation
```

---

## Instruction Hierarchy

This project uses a multi-level instruction system. **Always read these based on task:**

| Level | File | When |
|-------|------|------|
| **Root** | `.github/copilot-instructions.md` | Every task |
| **Features** | `docs/FEATURES.md` | Check before implementing |
| **Backend** | `apps/backend/.instructions.md` | .NET work |
| **Frontend** | `apps/admin/.instructions.md` | React work |
| **Crypto** | `libs/crypto/.instructions.md` | Crypto operations |
| **E2E Tests** | `tests/e2e/.instructions.md` | Test modifications |
| **Agents** | `.github/agents.md` | Security/test personas |

See `docs/INSTRUCTION_TREE.md` for the complete hierarchy.

---

## Development Workflow

### TDD is Mandatory

```text
🔴 RED    → Write failing test first
🟢 GREEN  → Minimum code to pass
🔵 REFACTOR → Improve while green
```

### Definition of Done

- [ ] Feature implemented (no stubs/TODOs)
- [ ] Tests written and passing
- [ ] No TypeScript/C# errors
- [ ] Documented in `docs/FEATURES.md` if user-facing
- [ ] Committed: `type(scope): description`

---

## Key Patterns

### Frontend

```typescript
// Worker communication via Comlink
const result = await cryptoWorker.encryptShard(data, key, epochId, shardIndex);

// Always handle crypto errors explicitly
try {
  const decrypted = await cryptoWorker.decryptShard(envelope, epochKey);
} catch (error) {
  throw new DecryptionError('Decryption failed');
}
```

### Backend

```csharp
// Use async/await consistently, TypedResults for minimal APIs
public async Task<IResult> GetAlbum(Guid albumId)
{
    var album = await _db.Albums.FindAsync(albumId);
    return album is null ? TypedResults.NotFound() : TypedResults.Ok(album);
}
```

### Crypto

```typescript
// ALWAYS generate fresh 24-byte nonce
const nonce = sodium.randombytes_buf(24);

// ALWAYS wipe keys after use
sodium.memzero(sensitiveKey);
```

---

## ⚠️ Terminal Commands (Non-Interactive Only)

Commands that wait for input will hang. Always use:

| ❌ Never | ✅ Always |
|----------|-----------|
| `vitest` | `vitest run` |
| `npm test` (watch) | `npm run test:run` |
| `dotnet watch` | `dotnet run` |
| `git commit` | `git commit -m "msg"` |

---

## Documentation Index

| Doc | Purpose |
|-----|---------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, component diagrams |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup guide, all dev methods |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature catalog (check before coding) |
| [docs/SECURITY.md](docs/SECURITY.md) | Zero-knowledge model, threat model |
| [docs/TECH_STACK.md](docs/TECH_STACK.md) | All technologies and versions |
