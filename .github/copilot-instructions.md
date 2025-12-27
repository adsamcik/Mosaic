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
- Test edge cases: empty inputs, max sizes, invalid data
- Verify cryptographic invariants (nonce uniqueness, key wiping)

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

### Task Tracking with Todos

**Always use the todo tool** to track all work that needs to be done. This ensures visibility and prevents tasks from being forgotten.

- **Create todos immediately** when identifying work items, bugs, or improvements
- **Break down complex tasks** into smaller, actionable todo items
- **Mark todos in-progress** before starting work (one at a time)
- **Mark todos completed** immediately after finishing each item
- **Never batch completions** - update status as soon as each task is done
- **Include context** in todo descriptions: file paths, function names, acceptance criteria

Example todo workflow:
1. User requests a feature → Create todos for each implementation step
2. Pick first todo → Mark as in-progress
3. Complete the work → Mark as completed, commit
4. Repeat until all todos are done

### After Completing Each Unit of Work

1. **Test** - Run relevant tests to verify correctness
   - Unit tests for new/modified functions
   - Integration tests if API changes
   - Manual verification for UI changes
2. **Verify** - Check for errors and warnings
   - No TypeScript/C# compiler errors
   - No ESLint/linting warnings
   - No failing tests
3. **Commit** - Create atomic, well-described commits
   - Use conventional commit format: `type(scope): description`
   - Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
   - Keep commits focused on a single logical change
   - Example: `feat(crypto): implement XChaCha20-Poly1305 envelope encryption`

Never leave work uncommitted. Each completed feature, fix, or refactor should result in a passing test suite and a clean commit.
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