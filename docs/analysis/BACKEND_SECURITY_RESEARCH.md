# Mosaic Backend Security Research Report

**Generated:** 2026-01-27  
**Scope:** Backend .NET 10 API Security Analysis  
**Methodology:** Static code analysis of authentication, authorization, input validation, and security patterns

---

## Executive Summary

The Mosaic backend demonstrates **strong security practices** with a well-designed authentication middleware pipeline, proper authorization checks at the controller level, and comprehensive input validation. The zero-knowledge architecture is correctly implemented with the server never inspecting encrypted content.

### Overall Security Rating: **Good**

| Category | Rating | Notes |
|----------|--------|-------|
| Authentication | ✅ Strong | Dual auth modes with proper validation |
| Authorization | ✅ Strong | Consistent membership/ownership checks |
| Input Validation | ✅ Good | MaxLength attributes, runtime validation |
| SQL Injection | ✅ Protected | Parameterized queries, EF Core |
| Path Traversal | ✅ Protected | Explicit key validation |
| Error Handling | ✅ Good | Generic errors to clients |
| CORS | ⚠️ Not Configured | Relies on reverse proxy (by design) |
| Development Endpoints | ⚠️ Review | Properly gated but exist in codebase |

---

## 1. Authentication Implementation

### 1.1 Middleware Pipeline Configuration

**File:** [Program.cs](apps/backend/Mosaic.Backend/Program.cs#L112-L128)

```csharp
// Middleware order matters:
// 0. ForwardedHeaders - process X-Forwarded-* headers from reverse proxy (must be first)
// 1. GlobalExceptionMiddleware - catch all errors first
// 2. CorrelationIdMiddleware - generate/extract correlation ID
// 3. LogScopeMiddleware - create logging scope with request context
// 4. RequestTimingMiddleware - log request timing
// 5. Auth middleware - authenticate user
app.UseForwardedHeaders();
app.UseMiddleware<GlobalExceptionMiddleware>();
app.UseMiddleware<CorrelationIdMiddleware>();
app.UseLogScope();
app.UseMiddleware<RequestTimingMiddleware>();

// [...auth middleware...]
app.UseMiddleware<CombinedAuthMiddleware>();
app.UseAuthentication();
app.UseAuthorization();
app.UseAdminAuth();
```

**Finding:** ✅ **GOOD** - Middleware is correctly ordered:
- `UseForwardedHeaders()` comes first for proper IP detection behind proxy
- `UseAuthentication()` precedes `UseAuthorization()` (OWASP compliance)
- Admin auth is the final layer, after general auth

### 1.2 CombinedAuthMiddleware - Dual Auth Support

**File:** [CombinedAuthMiddleware.cs](apps/backend/Mosaic.Backend/Middleware/CombinedAuthMiddleware.cs)

The middleware supports two independent authentication modes:

#### LocalAuth (Session-based)
```csharp
// Lines 95-137
private async Task<bool> TryLocalAuth(HttpContext context, MosaicDbContext db)
{
    // Get session token from cookie
    if (!context.Request.Cookies.TryGetValue("mosaic_session", out var tokenBase64))
        return false;

    // [...token parsing...]

    // Look up session by token hash
    var tokenHash = SHA256.HashData(token);
    var session = await db.Sessions
        .Include(s => s.User)
        .FirstOrDefaultAsync(s =>
            s.TokenHash == tokenHash &&
            s.RevokedAt == null &&
            s.ExpiresAt > DateTime.UtcNow);

    // [...session validation, sliding expiry check...]
}
```

**Security Features:**
- ✅ Session tokens are hashed (SHA256) before storage
- ✅ Sliding expiry (7 days) with absolute expiry (30 days)
- ✅ Single-use challenges with 60-second expiry
- ✅ Rate limiting (10 attempts/minute per IP)

#### ProxyAuth (Trusted Reverse Proxy)
```csharp
// Lines 139-172
private bool TryProxyAuth(HttpContext context)
{
    var remoteIp = context.Connection.RemoteIpAddress;
    
    // Check if request is from trusted proxy
    var isTrusted = _trustedNetworks.Any(network => network.Contains(remoteIp));
    if (!isTrusted)
    {
        _logger.LogDebug("Request from untrusted IP: {IP}", remoteIp);
        return false;
    }

    var remoteUser = context.Request.Headers["Remote-User"].FirstOrDefault();
    if (!ValidUserPattern().IsMatch(remoteUser))
    {
        _logger.LogWarning("Invalid Remote-User format: {User}", remoteUser);
        return false;
    }
    // [...]
}
```

**Security Features:**
- ✅ IP-based proxy validation with CIDR network matching
- ✅ Remote-User header format validation via regex: `^[a-zA-Z0-9_\-@.]+$`
- ✅ Untrusted IPs are logged and rejected

### 1.3 Public Paths Configuration

**File:** [CombinedAuthMiddleware.cs#L29-L42](apps/backend/Mosaic.Backend/Middleware/CombinedAuthMiddleware.cs#L29-L42)

```csharp
private static readonly string[] PublicPaths =
[
    "/health",
    "/api/health",
    "/api/auth/init",
    "/api/auth/config",
    "/api/auth/verify",
    "/api/auth/register",
    "/api/dev-auth/",     // ⚠️ Development-only
    "/api/test-seed/",    // ⚠️ E2E test seeding
    "/api/s/",            // Anonymous share links
    "/swagger",
    "/openapi"
];
```

**⚠️ RECOMMENDATION:** The `PublicPaths` array includes development/test endpoints. While these are gated by environment checks in their controllers, consider:
1. Removing them from the array in production builds
2. Adding compile-time conditional compilation

---

## 2. Authorization Checks Matrix

### 2.1 Endpoint Authorization Matrix

| Controller | Endpoint | Auth Required | Authorization Check |
|------------|----------|---------------|---------------------|
| **AlbumsController** | | | |
| | `GET /api/albums` | ✅ Session | Filters to user's albums only |
| | `POST /api/albums` | ✅ Session | Any authenticated user |
| | `GET /api/albums/{id}` | ✅ Session | Album membership check |
| | `DELETE /api/albums/{id}` | ✅ Session | Owner only |
| | `PATCH /api/albums/{id}/name` | ✅ Session | Owner or Editor |
| | `PATCH /api/albums/{id}/expiration` | ✅ Session | Owner only |
| **MembersController** | | | |
| | `GET /api/albums/{id}/members` | ✅ Session | Album membership |
| | `POST /api/albums/{id}/members` | ✅ Session | CanUpload role check |
| | `DELETE /api/albums/{id}/members/{userId}` | ✅ Session | Owner only |
| **ManifestsController** | | | |
| | `POST /api/manifests` | ✅ Session | Album member + CanUpload |
| | `GET /api/manifests/{id}` | ✅ Session | Album membership |
| | `DELETE /api/manifests/{id}` | ✅ Session | Album member + CanUpload |
| **ShardsController** | | | |
| | `GET /api/shards/{id}` | ✅ Session | Album membership via manifest |
| **ShareLinksController** | | | |
| | `POST /api/albums/{id}/share-links` | ✅ Session | Owner only |
| | `GET /api/albums/{id}/share-links` | ✅ Session | Owner only |
| | `DELETE /api/share-links/{id}` | ✅ Session | Owner only |
| | `GET /api/s/{linkId}` | ❌ Anonymous | Link validity check |
| | `GET /api/s/{linkId}/keys` | ❌ Anonymous | Link validity check |
| | `GET /api/s/{linkId}/photos` | ❌ Anonymous | Link validity check |
| | `GET /api/s/{linkId}/shards/{shardId}` | ❌ Anonymous | Link + shard belongs to album |
| **AuthController** | | | |
| | `GET /api/auth/config` | ❌ Public | Always public |
| | `POST /api/auth/init` | ❌ Public | Rate limited |
| | `POST /api/auth/verify` | ❌ Public | Rate limited |
| | `POST /api/auth/register` | ❌ Public | Rate limited |
| | `POST /api/auth/logout` | ✅ Session | Current user only |
| **Admin Controllers** | | | |
| | All `/api/admin/*` | ✅ Session + Admin | `IsAdmin = true` required |
| **DevAuthController** | | | |
| | `POST /api/dev-auth/login` | ❌ Dev Only | `IsDevelopment()` check |
| **TestSeedController** | | | |
| | All `/api/test-seed/*` | ❌ Test Only | `IsDevelopment() \|\| IsEnvironment("Testing")` |

### 2.2 Role-Based Access Control Implementation

**File:** [AlbumRoles.cs (referenced in controllers)](apps/backend/Mosaic.Backend/Data/Entities/Album.cs)

```csharp
// Used throughout controllers
if (!AlbumRoles.CanUpload(membership.Role))
{
    return Forbid();
}
```

Roles hierarchy:
- **owner** - Full access, can invite/remove members, create share links, delete album
- **editor** - Can upload photos, rename album
- **viewer** - Read-only access

### 2.3 Authorization Code Patterns

**Good Pattern - Membership Check:**
```csharp
// AlbumsController.cs:276-289
var membership = await _db.AlbumMembers
    .Where(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null)
    .FirstOrDefaultAsync();

if (membership == null)
{
    return Forbid();
}
```

**Good Pattern - Owner-Only Check:**
```csharp
// AlbumsController.cs:439-444
if (album.OwnerId != user.Id)
{
    return Forbid();
}
```

**Good Pattern - Role-Based Check:**
```csharp
// ManifestsController.cs:138-142
if (!AlbumRoles.CanUpload(membership.Role))
{
    return Forbid();
}
```

---

## 3. Input Validation Analysis

### 3.1 Data Annotations Usage

**File:** [AlbumsController.cs#L21-76](apps/backend/Mosaic.Backend/Controllers/AlbumsController.cs#L21-76)

```csharp
public class CreateAlbumRequest
{
    public required InitialEpochKeyRequest InitialEpochKey { get; set; }

    [MaxLength(2048)]
    public string? EncryptedName { get; set; }

    [MaxLength(8192)]
    public string? EncryptedDescription { get; set; }
}

public class InitialEpochKeyRequest
{
    [MaxLength(4096)]
    public required byte[] EncryptedKeyBundle { get; set; }

    [MaxLength(128)]
    public required byte[] OwnerSignature { get; set; }

    [MaxLength(64)]
    public required byte[] SharerPubkey { get; set; }

    [MaxLength(64)]
    public required byte[] SignPubkey { get; set; }
}
```

**Finding:** ✅ Consistent use of `[MaxLength]` attributes on request DTOs.

### 3.2 Runtime Validation Examples

**File:** [AlbumsController.cs#L131-152](apps/backend/Mosaic.Backend/Controllers/AlbumsController.cs#L131-152)

```csharp
// Validate request
if (request.InitialEpochKey == null)
{
    return BadRequest(new { error = "initialEpochKey is required" });
}

if (request.InitialEpochKey.EncryptedKeyBundle == null || request.InitialEpochKey.EncryptedKeyBundle.Length == 0)
{
    return BadRequest(new { error = "encryptedKeyBundle is required" });
}

// Validate expiration if provided
if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
{
    return BadRequest(new { error = "expiresAt must be in the future" });
}
```

**File:** [AuthController.cs#L319-344](apps/backend/Mosaic.Backend/Controllers/AuthController.cs#L319-344)

```csharp
// Validate key lengths
byte[] userSalt, accountSalt, wrappedAccountKey, wrappedIdentitySeed;
try
{
    userSalt = Convert.FromBase64String(request.UserSalt);
    accountSalt = Convert.FromBase64String(request.AccountSalt);

    if (userSalt.Length != 16)
    {
        return BadRequest(new { error = "UserSalt must be 16 bytes" });
    }

    if (accountSalt.Length != 16)
    {
        return BadRequest(new { error = "AccountSalt must be 16 bytes" });
    }
}
catch (FormatException)
{
    return BadRequest(new { error = "Invalid base64 encoding" });
}
```

### 3.3 Username/Input Format Validation

**File:** [CombinedAuthMiddleware.cs#L27](apps/backend/Mosaic.Backend/Middleware/CombinedAuthMiddleware.cs#L27)

```csharp
[GeneratedRegex(@"^[a-zA-Z0-9_\-@.]+$", RegexOptions.Compiled)]
private static partial Regex ValidUserPattern();
```

**Finding:** ✅ Consistent regex pattern for username validation prevents injection attacks.

---

## 4. SQL Injection Prevention

### 4.1 Primary Protection: Entity Framework Core

All database operations use Entity Framework Core with LINQ queries, which automatically parameterizes values.

**Example - Safe LINQ Query:**
```csharp
// MembersController.cs:32-34
var hasAccess = await _db.AlbumMembers
    .AnyAsync(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null);
```

### 4.2 Raw SQL Usage Analysis

**Files using raw SQL:**

| File | Line | Pattern | Safe? |
|------|------|---------|-------|
| [ManifestsController.cs](apps/backend/Mosaic.Backend/Controllers/ManifestsController.cs#L121) | 121 | `FromSqlRaw(...{0}...)` | ✅ Parameterized |
| [ManifestsController.cs](apps/backend/Mosaic.Backend/Controllers/ManifestsController.cs#L335) | 335 | `FromSqlRaw(...{0}...)` | ✅ Parameterized |
| [TusEventHandlers.cs](apps/backend/Mosaic.Backend/Services/TusEventHandlers.cs#L85-91) | 85-91 | `ExecuteSqlRawAsync(...{0}...)` | ✅ Parameterized |
| [GarbageCollectionService.cs](apps/backend/Mosaic.Backend/Services/GarbageCollectionService.cs#L66-70) | 66-70 | `ExecuteSqlRawAsync(sql)` | ⚠️ String interpolation |
| [HealthController.cs](apps/backend/Mosaic.Backend/Controllers/HealthController.cs#L20) | 20 | `ExecuteSqlRawAsync("SELECT 1")` | ✅ Static string |

**Detailed Analysis of GarbageCollectionService:**

```csharp
// GarbageCollectionService.cs:63-70
var nowFunc = _useSqlite ? "datetime('now')" : "NOW()";
var sql = $@"
    UPDATE shards 
    SET status = 'TRASHED', status_updated_at = {nowFunc} 
    WHERE status = 'PENDING' AND pending_expires_at < {nowFunc}";

var count = await db.Database.ExecuteSqlRawAsync(sql);
```

**Finding:** ✅ **SAFE** - Although this uses string interpolation, the `nowFunc` variable is a hardcoded constant (`"datetime('now')"` or `"NOW()"`), not user input. No SQL injection risk.

---

## 5. Path Traversal Prevention

### 5.1 Storage Key Validation

**File:** [LocalStorageService.cs#L16-32](apps/backend/Mosaic.Backend/Services/LocalStorageService.cs#L16-32)

```csharp
/// <summary>
/// Validates that a storage key doesn't contain path traversal sequences.
/// </summary>
private static void ValidateKey(string key)
{
    if (string.IsNullOrEmpty(key))
        throw new ArgumentException("Storage key cannot be null or empty", nameof(key));

    // Prevent path traversal attacks
    // Explicitly check for both separators regardless of platform
    if (key.Contains("..") ||
        key.Contains('/') ||
        key.Contains('\\'))
    {
        throw new ArgumentException("Storage key contains invalid path characters", nameof(key));
    }
}
```

**Finding:** ✅ **EXCELLENT** - Comprehensive path traversal protection:
- Blocks `..` sequences
- Blocks both `/` and `\` separators regardless of platform
- Validates all storage operations through `OpenReadAsync` and `DeleteAsync`

### 5.2 Shard ID Generation

Shard IDs are UUIDs generated server-side via Tus upload protocol. The client never controls file paths directly.

```csharp
// TusEventHandlers.cs:76-82
db.Shards.Add(new Shard
{
    Id = Guid.Parse(fileId),  // UUID from Tus
    StorageKey = fileId,       // Same UUID as storage key
    // ...
});
```

---

## 6. Error Handling and Information Leakage

### 6.1 Global Exception Middleware

**File:** [GlobalExceptionMiddleware.cs](apps/backend/Mosaic.Backend/Middleware/GlobalExceptionMiddleware.cs)

```csharp
private async Task HandleExceptionAsync(HttpContext context, Exception exception)
{
    var correlationId = context.GetCorrelationId() ?? Guid.NewGuid().ToString();

    // Determine appropriate status code based on exception type
    var statusCode = exception switch
    {
        UnauthorizedAccessException => HttpStatusCode.Unauthorized,
        _ => HttpStatusCode.InternalServerError
    };

    // Log ALL exceptions during development for debugging
    _logger.LogError(exception,
        "Exception in {Path}: {ExceptionType} - {Message}",
        path, exception.GetType().Name, exception.Message);

    // Return generic error to client - never expose exception details
    var response = new
    {
        error = statusCode == HttpStatusCode.Unauthorized
            ? "Authentication required"
            : "An unexpected error occurred",
        correlationId = correlationId
    };
    // [...]
}
```

**Finding:** ✅ **GOOD** - Exception details are logged server-side but only generic messages returned to clients. Correlation IDs enable debugging without leaking sensitive info.

### 6.2 Authentication Error Responses

**File:** [AuthController.cs#L246-262](apps/backend/Mosaic.Backend/Controllers/AuthController.cs#L246-262)

```csharp
// User doesn't exist or doesn't have local auth set up
// Return same error to prevent enumeration
_logger.AuthChallengeFailed(request.Username, "user not found or no local auth");
return Unauthorized(new { error = "Invalid credentials" });
```

**Finding:** ✅ **GOOD** - Same error message for invalid username vs invalid password prevents user enumeration.

### 6.3 Algorithm-Uniform Salt Generation

**File:** [AuthController.cs#L621-643](apps/backend/Mosaic.Backend/Controllers/AuthController.cs#L621-643)

```csharp
private byte[] GenerateFakeSalt(string username)
{
    // Deterministic fake salt: SHA256(serverSecret || "fake_salt" || username)
    var combined = serverSecret
        .Concat(System.Text.Encoding.UTF8.GetBytes("fake_salt"))
        .Concat(System.Text.Encoding.UTF8.GetBytes(username))
        .ToArray();

    return SHA256.HashData(combined)[..16];
}
```

**Finding:** ✅ **EXCELLENT** - Non-existent users receive a deterministic fake salt, preventing timing-based user enumeration.

---

## 7. ForwardedHeaders Configuration

**File:** [Program.cs#L83-86](apps/backend/Mosaic.Backend/Program.cs#L83-86)

```csharp
// Configure forwarded headers for reverse proxy support
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
});
```

**Finding:** ⚠️ **REVIEW** - The configuration uses default values which may need adjustment:

1. **Missing `KnownProxies`/`KnownNetworks`:** The `TrustedProxies` are checked in `CombinedAuthMiddleware`, but the `ForwardedHeadersOptions` doesn't explicitly set `KnownNetworks`. This is acceptable because:
   - The authentication middleware performs its own IP validation
   - However, `X-Forwarded-For` will be trusted from any source for logging purposes

**Recommendation:** Add explicit proxy networks to `ForwardedHeadersOptions` for defense-in-depth:
```csharp
options.KnownNetworks.Add(new IPNetwork(IPAddress.Parse("172.16.0.0"), 12));
```

---

## 8. CORS Configuration

**Finding:** ❌ **NOT CONFIGURED** in the .NET backend.

**Justification:** This is **by design**. The documentation indicates CORS is handled at the reverse proxy layer (Nginx/Traefik):

From `docs/DOCKER.md`:
> Pre-configured CORS headers for SharedArrayBuffer

The application requires COOP/COEP headers for SharedArrayBuffer access, which are configured in `apps/admin/nginx.conf` and the reverse proxy.

**Security Note:** This is acceptable for the intended deployment model (behind reverse proxy), but the backend should NOT be exposed directly to the internet.

---

## 9. Potential Auth Bypass Vectors

### 9.1 Development-Only Endpoints

**DevAuthController** ([DevAuthController.cs](apps/backend/Mosaic.Backend/Controllers/DevAuthController.cs))

```csharp
[HttpPost("login")]
public async Task<IActionResult> DevLogin([FromBody] DevLoginRequest request)
{
    // Security: Only allow in Development environment
    if (!_env.IsDevelopment())
    {
        return NotFound();
    }

    // Security: Only allow when LocalAuth is enabled
    if (!_isLocalAuthMode)
    {
        return NotFound();
    }
    // [...]
}
```

**Status:** ✅ **PROTECTED** - Requires both `ASPNETCORE_ENVIRONMENT=Development` AND `Auth:LocalAuthEnabled=true`.

### 9.2 Test Seeding Endpoints

**TestSeedController** ([TestSeedController.cs](apps/backend/Mosaic.Backend/Controllers/TestSeedController.cs))

```csharp
private bool IsTestEnvironment()
{
    return _env.IsDevelopment() || _env.IsEnvironment("Testing");
}

[HttpPost("reset")]
public async Task<IActionResult> Reset()
{
    if (!IsTestEnvironment())
    {
        return NotFound();
    }
    // [...]
}
```

**Status:** ✅ **PROTECTED** - Requires `Development` or `Testing` environment.

**⚠️ RECOMMENDATION:** Consider adding additional safeguards:
1. Require a secret header/token for test endpoints
2. Log all test endpoint access with alert-level severity in production environments
3. Use `#if DEBUG` compilation directives to exclude from release builds

### 9.3 Rate Limiting Bypass

**File:** [AuthController.cs#L121-131](apps/backend/Mosaic.Backend/Controllers/AuthController.cs#L121-131)

```csharp
// Skip rate limiting in Development and Testing environments for easier testing
if (!_env.IsDevelopment() && !_env.IsEnvironment("Testing"))
{
    var oneMinuteAgo = DateTime.UtcNow.AddMinutes(-1);
    var recentChallenges = await _db.AuthChallenges
        .Where(c => c.IpAddress == ipAddress && c.CreatedAt > oneMinuteAgo)
        .CountAsync();

    if (recentChallenges >= 10)
    {
        _logger.AuthRateLimited(request.Username);
        return StatusCode(429, new { error = "Too many requests. Please wait." });
    }
}
```

**Status:** ⚠️ **ACCEPTABLE** - Rate limiting is disabled only in non-production environments. Ensure `ASPNETCORE_ENVIRONMENT` is never `Development` or `Testing` in production.

---

## 10. Security Test Coverage

**File:** [SecurityTests.cs](apps/backend/Mosaic.Backend.Tests/SecurityTests.cs)

The codebase includes comprehensive security tests covering:

| Test Category | Test Count | Coverage |
|---------------|------------|----------|
| Album Access Control | 5 | ✅ |
| Member Management Authorization | 4 | ✅ |
| Manifest Access Control | 4 | ✅ |
| Epoch Key Access Control | 2 | ✅ |
| Cross-User Data Isolation | 2 | ✅ |
| Share Link Security | 4 | ✅ |
| Input Validation Security | 2 | ✅ |

**Notable Test Patterns:**

```csharp
[Fact]
public async Task Security_Albums_NonexistentAlbumReturnsUnauthorizedToPreventEnumeration()
{
    // [...setup...]
    var result = await controller.Get(Guid.NewGuid());
    
    // Assert - Returns Forbid for non-existent albums to prevent enumeration attacks.
    // An attacker cannot distinguish between "doesn't exist" and "not authorized".
    Assert.IsType<ForbidResult>(result);
}
```

---

## 11. OWASP Top 10 Analysis

| # | Vulnerability | Status | Notes |
|---|---------------|--------|-------|
| A01:2021 | Broken Access Control | ✅ Mitigated | Consistent ownership/membership checks |
| A02:2021 | Cryptographic Failures | ✅ Mitigated | Server never sees plaintext; proper token hashing |
| A03:2021 | Injection | ✅ Mitigated | Parameterized queries; path traversal protection |
| A04:2021 | Insecure Design | ✅ Good | Zero-knowledge architecture by design |
| A05:2021 | Security Misconfiguration | ⚠️ Review | Dev endpoints exist; CORS at proxy level |
| A06:2021 | Vulnerable Components | N/A | Requires dependency scan |
| A07:2021 | Identification & Auth Failures | ✅ Mitigated | Session management, rate limiting |
| A08:2021 | Software & Data Integrity | ✅ Mitigated | Signature verification in crypto layer |
| A09:2021 | Security Logging & Monitoring | ✅ Good | Structured logging, correlation IDs |
| A10:2021 | Server-Side Request Forgery | ✅ N/A | No external URL fetching |

---

## 12. Recommendations

### High Priority

1. **ForwardedHeaders Hardening** - Add `KnownNetworks` to `ForwardedHeadersOptions` for defense-in-depth.

2. **Production Build Exclusion** - Consider `#if DEBUG` directives for DevAuthController and TestSeedController to ensure they're excluded from release builds.

### Medium Priority

3. **Test Endpoint Protection** - Add a secret header requirement for `/api/test-seed/*` endpoints even in test environments.

4. **Cookie Security Audit** - Verify cookie `SameSite=Strict` is enforced in production (currently set based on environment).

5. **Request Size Limits** - Consider adding `[RequestSizeLimit]` attributes to endpoints accepting large payloads.

### Low Priority

6. **Security Headers** - Consider adding security headers at the application level as backup (CSP, X-Content-Type-Options, etc.) even though they're set at the proxy layer.

7. **Dependency Scanning** - Implement automated dependency vulnerability scanning (e.g., `dotnet list package --vulnerable`).

---

## 13. Summary

The Mosaic backend demonstrates mature security practices:

**Strengths:**
- ✅ Well-designed dual authentication system (LocalAuth + ProxyAuth)
- ✅ Consistent authorization checks at all endpoints
- ✅ Comprehensive input validation with Data Annotations and runtime checks
- ✅ Parameterized SQL queries throughout
- ✅ Robust path traversal prevention
- ✅ Generic error messages preventing information leakage
- ✅ Anti-enumeration protections (fake salts, uniform error responses)
- ✅ Extensive security test coverage
- ✅ Zero-knowledge architecture correctly implemented

**Areas for Improvement:**
- ⚠️ Development endpoints present in production builds
- ⚠️ ForwardedHeaders could be hardened with KnownNetworks
- ⚠️ CORS relies entirely on reverse proxy (by design, but document requirement)

The security posture is appropriate for the stated use case: a zero-knowledge photo gallery behind a trusted reverse proxy for small-scale personal use.
