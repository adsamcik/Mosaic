# Mosaic - GitHub Copilot Instructions

## Project Overview

Mosaic is a **zero-knowledge encrypted photo gallery** for small-scale personal use (≤50 users). The server never sees plaintext photos or metadata—all encryption/decryption happens client-side.

## Philosophy (Priority Order)

1. **Correctness** - Code must work as specified
2. **Security** - Cryptographic operations must be bulletproof
3. **Simplicity** - Prefer readable code over clever optimizations
4. **Performance** - Optimize only when necessary

## Architecture

```
libs/crypto/       # Shared crypto library (TypeScript)
apps/backend/      # .NET 10 ASP.NET Core API
apps/admin/        # React 19 + Vite frontend
docs/              # Documentation
```

## Technology Stack

### Backend (.NET 10)
- ASP.NET Core minimal APIs or controllers
- Entity Framework Core with PostgreSQL
- Tus protocol for resumable uploads
- Authentication via trusted reverse proxy (Remote-User header)

### Frontend (React 19 + Vite)
- TypeScript strict mode
- Web Workers for crypto and database operations
- SQLite-WASM with OPFS for local storage
- libsodium-wrappers for cryptography
- Comlink for worker communication
- TanStack Virtual for virtualized lists

### Crypto Library
- XChaCha20-Poly1305 for encryption
- Ed25519 for signing
- Argon2id for key derivation
- HKDF-SHA256 for key expansion

## Cryptographic Guidelines

### CRITICAL: Nonce Handling
- **ALWAYS** generate 24 fresh random bytes per encryption
- **NEVER** reuse a nonce with the same key
- Use `sodium.randombytes_buf(24)` for nonce generation

### Key Hierarchy
```
L0 (Master)  = Argon2id(password, salt)     # Never stored
L1 (Root)    = HKDF(L0, account_salt)        # Never stored
L2 (Account) = random(32), wrapped by L1    # Stored encrypted
L3 (Epoch)   = ReadKey + SignKey per album  # Distributed to members
```

### Memory Safety
- Always call `sodium.memzero()` on sensitive keys after use
- Never log or serialize plaintext keys
- Clear session keys on logout

### Envelope Format (64 bytes header)
```
Magic(4) | Version(1) | Epoch(4) | Shard(4) | Nonce(24) | Reserved(27)
```
- Reserved bytes MUST be zero and validated on decrypt
- AAD = entire 64-byte header

## Code Patterns

### Backend (C#)

```csharp
// Use async/await consistently
public async Task<IActionResult> GetAlbum(Guid albumId)
{
    var userId = GetCurrentUserId();
    var album = await _db.Albums.FindAsync(albumId);
    
    if (album == null) return NotFound();
    if (album.OwnerId != userId) return Forbid();
    
    return Ok(album);
}

// Use transactions for multi-step operations
await using var tx = await _db.Database.BeginTransactionAsync();
try
{
    // ... operations
    await tx.CommitAsync();
}
catch
{
    await tx.RollbackAsync();
    throw;
}
```

### Frontend (TypeScript)

```typescript
// Worker communication via Comlink
import { wrap } from 'comlink';

const cryptoWorker = wrap<CryptoWorker>(
  new Worker(new URL('./workers/crypto.worker.ts', import.meta.url), { type: 'module' })
);

// Always handle errors in crypto operations
try {
  const decrypted = await cryptoWorker.decryptShard(envelope, epochKey);
} catch (error) {
  console.error('Decryption failed:', error);
  throw new DecryptionError('Failed to decrypt shard');
}
```

### Crypto Library

```typescript
// Validate inputs before crypto operations
export function encryptShard(
  data: Uint8Array,
  readKey: Uint8Array,
  epochId: number,
  shardIndex: number
): EncryptedShard {
  if (readKey.length !== 32) {
    throw new Error('Invalid key length');
  }
  
  const nonce = sodium.randombytes_buf(24);
  // ... encryption logic
}
```

## Database Conventions

- Use UUIDv7 for primary keys (time-ordered)
- Timestamps are always `TIMESTAMPTZ` (UTC)
- Use `snake_case` for table/column names
- Index foreign keys and common query patterns

## Security Rules

1. **Never trust client input** - Validate everything server-side
2. **Verify before decrypt** - Check signatures before processing sealed boxes
3. **Minimal permissions** - Users only access their own albums/shared albums
4. **Shard integrity** - Verify SHA256 of downloaded shards against signed manifest
5. **No PII in logs** - Never log user data, passwords, or keys

## Error Handling

- Use typed errors with meaningful messages
- Don't expose internal details to clients
- Log errors with context for debugging
- Fail fast on cryptographic errors

## Testing Expectations

- Unit tests for all crypto functions
- Integration tests for API endpoints
- E2E tests for user-facing flows
- Test edge cases: empty inputs, max sizes, invalid data
- Verify cryptographic invariants (nonce uniqueness, key wiping)

### Coverage Thresholds
- Crypto library: 85% lines/functions, 75% branches
- Run `npm run test:coverage` to verify coverage
- Coverage must not regress from current levels

### Test-First Approach (Recommended)
For complex logic, write the test first to clarify expected behavior. This ensures coverage and forces clear API design before implementation.

## Browser Support

Modern browsers only (no fallbacks):
- Chrome/Edge 102+
- Firefox 111+
- Safari 16.4+

Required headers for SharedArrayBuffer:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## File Naming Conventions

- TypeScript: `kebab-case.ts` for files, `PascalCase` for components
- C#: `PascalCase.cs` for all files
- SQL migrations: `V{number}__{description}.sql`

## When Generating Code

1. Follow existing patterns in the codebase
2. Include proper error handling
3. Add JSDoc/XML comments for public APIs
4. Consider security implications
5. Prefer explicit types over inference for public APIs

## Workflow Requirements

### Execution Rules

**Complete every task fully in this session.** You are an autonomous agent—execute immediately, do not defer.

- **Do the work now** - Implement features, write tests, run them, commit. All in one session.
- **Never defer** - Do not suggest "you could add tests later" or "consider implementing X."
- **Never leave incomplete work** - No stubs, no placeholders, no partial implementations.
- **Never suggest future improvements** - If it should be done, do it now.
- **Forbidden phrases**: "optionally," "you might want to," "consider adding," "as a next step," "you could also"

If a task has multiple parts, complete ALL parts before responding. Do not ask permission to continue—just do it.

### Definition of Done

**Every task—regardless of size—must satisfy ALL criteria before completion:**

- [ ] Feature code implemented (no stubs, no placeholders, no `// TODO`)
- [ ] Unit tests written and passing
- [ ] Integration tests added if API changes
- [ ] E2E tests added if UI changes
- [ ] Tests executed locally with output reported (e.g., "23 passed, 94% coverage")
- [ ] No TypeScript/C#/ESLint errors or warnings
- [ ] Committed with conventional format: `type(scope): description`

This applies equally to quick fixes, new features, and refactors. No exceptions.

### Local Test Commands

Run these commands to verify your work:

```bash
# Crypto library
cd libs/crypto && npm test
cd libs/crypto && npm run test:coverage  # Verify 85% threshold

# Frontend
cd apps/admin && npm test

# Backend
cd apps/backend/Mosaic.Backend && dotnet test

# Full suite (all tests)
./scripts/run-tests.ps1 -Suite all     # Windows
./scripts/run-tests.sh --suite all     # Linux/Mac
```

**You must run tests and report the output.** Do not say "tests should pass"—prove they passed.

### Anti-Patterns (Forbidden)

- **`// TODO` comments** - Unless the user explicitly requests a placeholder
- **Placeholder implementations** - `throw new NotImplementedException()`, `pass`, empty functions
- **Deferring tests** - "Tests can be added later" is never acceptable
- **Suggesting manual verification** - "You can test this by..." — run the tests yourself
- **Incomplete error handling** - Every error path must be handled
- **Weasel words** - "optionally," "might," "could," "consider," "perhaps"

### Blockers Policy

**If you cannot complete the task, ask immediately.** Do not:
- Leave partial work and suggest the user finish it
- Defer to a future session
- Make assumptions about ambiguous requirements

Valid reasons to ask:
- Missing dependency that cannot be installed
- Ambiguous requirements needing clarification
- Conflicting constraints in the request
- External service unavailable

Invalid reasons (just do it):
- "This might take a while" — do it anyway
- "This requires multiple files" — edit them all
- "I'm not sure about the test approach" — pick a reasonable approach and implement it
## Subagent Delegation

Use subagents to parallelize and delegate complex work. Subagents are autonomous agents that can research, search, and execute multi-step tasks independently.

### When to Use Subagents

- **Research tasks** - Investigating unfamiliar APIs, libraries, or patterns
- **Code search** - Finding implementations, usages, or patterns across the codebase
- **Multi-file analysis** - Understanding how components interact across the project
- **Parallel investigations** - When multiple independent research tasks are needed
- **Complex refactoring research** - Mapping all usages before making changes

### Subagent Guidelines

1. **Be specific** - Provide detailed prompts with clear objectives and expected outputs
2. **Define scope** - Specify whether the agent should research only or also write code
3. **Request structured output** - Tell the agent exactly what information to return
4. **Trust but verify** - Agent outputs are generally reliable but should be validated

### Example Delegation Patterns

```
# Research pattern
"Search the codebase for all usages of EpochKey. List each file, 
the function/method using it, and whether it's being created, 
read, or modified. Return a structured summary."

# Multi-component analysis
"Analyze how the upload flow works end-to-end: from the Upload 
component through the worker to the API. Document the data 
transformations at each step. Do not write code."

# Cross-cutting search
"Find all places where we handle authentication errors. Include 
frontend components, API clients, and backend middleware. Report 
file paths and line numbers for each occurrence."
```

### Benefits

- **Efficiency** - Delegate research while focusing on implementation
- **Thoroughness** - Agents systematically explore without missing edge cases
- **Parallelism** - Multiple investigations can inform a cohesive solution
- **Context gathering** - Build comprehensive understanding before coding