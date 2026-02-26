# C2PA + Invisible Watermarking Feasibility Analysis for Mosaic

**Date:** January 11, 2026  
**Author:** Architecture Review  
**Status:** Analysis Complete - **CLIENT-SIDE PARTIALLY FEASIBLE**

---

## Executive Summary

**Verdict: ⚠️ PARTIALLY POSSIBLE CLIENT-SIDE**

The **original proposal** (server-side processing) is **fundamentally incompatible** with Mosaic's zero-knowledge architecture.

However, **client-side implementation is now technically feasible** with recent updates to `c2pa-js` (v0.4.0+), which added browser-based signing via WASM. The key constraints are:

| Component | Client-Side Feasibility | Notes |
|-----------|------------------------|-------|
| **C2PA Signing** | ✅ **NOW POSSIBLE** | `c2pa-js` supports `builder.sign()` in browser via WASM |
| **Invisible Watermarking** | ⚠️ Requires custom WASM | No robust browser library exists; needs DCT-based implementation |
| **X.509 Certificates** | ⚠️ **Major Challenge** | User must provide their own cert, or use self-signed (limited trust) |
| **Zero-Knowledge** | ✅ Preserved | All processing before encryption, server never sees plaintext |

**Bottom Line:** C2PA signing is now browser-capable. The blockers are:
1. No off-the-shelf browser watermarking library with Imatag-level robustness
2. Certificate management UX (users need their own signing certs)

---

## 1. Original Proposal vs. Mosaic Architecture

### 1.1 The Core Conflict (Server-Side Approach)

| Proposed Architecture | Mosaic Architecture |
|----------------------|---------------------|
| Server receives plaintext image | Server receives only encrypted blobs |
| Server sends image to Imatag API for watermarking | Server has no access to image content |
| Server performs C2PA signing on watermarked image | All image processing is client-side |
| Server stores manifest and watermark UUID linkage | Server stores only opaque `byte[]` |

The proposal states:
> "Node.js backend sends the image buffer to the Imatag API"

In Mosaic, this is **impossible** because:

```
┌─────────────────────────────────────────────────────────────┐
│                       BROWSER                                │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  CRYPTO WORKER                                        │  │
│  │  ┌─────────────┐    ┌─────────────┐    ┌──────────┐  │  │
│  │  │ Generate    │ -> │ Encrypt     │ -> │ Upload   │  │  │
│  │  │ Thumbnails  │    │ with        │    │ Encrypted│  │  │
│  │  │ (plaintext) │    │ Epoch Keys  │    │ Shards   │  │  │
│  │  └─────────────┘    └─────────────┘    └──────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                           │
                           │ ENCRYPTED BLOBS ONLY
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                       BACKEND                                 │
│  Server sees: byte[64 header] + byte[ciphertext + 16B tag]   │
│  Server knows: Nothing about image content                    │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 Specific Violations (Server-Side)

| Proposal Step | Mosaic Invariant Violated |
|---------------|--------------------------|
| "Server reads user upload" | Server never decrypts content |
| "Call Imatag API with image buffer" | Would expose plaintext to third party |
| "Server stores watermark UUID ↔ manifest mapping" | Server cannot correlate plaintext features |
| "LocalSigner uses server-side private key" | Keys are client-side only |

From [SECURITY.md](../SECURITY.md):
> "Photo contents (encrypted with epoch ReadKey)" - What the Server Cannot Know

From [ARCHITECTURE.md](../ARCHITECTURE.md):
> "Server stores only encrypted blobs (opaque `byte[]`)"

---

## 2. Client-Side C2PA: Now Technically Possible

### 2.1 c2pa-js v0.4.0+ Breakthrough

**Good news:** The `@contentauth/c2pa-js` library (specifically `c2pa-web` package) now supports **full manifest building and signing in the browser** via WASM.

From the c2pa-js repository (contentauth/c2pa-js):

```typescript
// Browser-based C2PA signing is NOW SUPPORTED
import { createC2pa } from '@contentauth/c2pa-web';

const c2pa = await createC2pa({ wasmSrc: '/c2pa.wasm' });

// Create a builder
const builder = await c2pa.builder.fromDefinition({
  claim_generator_info: [{ name: 'Mosaic', version: '1.0.0' }],
  assertions: [
    {
      label: 'c2pa.actions',
      data: { actions: [{ action: 'c2pa.created' }] }
    }
  ]
});

// Sign with a user-provided signer
const signedBytes = await builder.sign(
  {
    reserveSize: 20000,
    alg: 'Es256',
    sign: async (bytes: Uint8Array) => {
      // User's signing function - could use WebCrypto or external service
      return await userSigningFunction(bytes);
    }
  },
  'image/jpeg',
  imageBlob
);
```

### 2.2 What c2pa-js Provides

| Feature | Status | Notes |
|---------|--------|-------|
| Manifest creation | ✅ | `builder.fromDefinition()`, `builder.addAction()` |
| Ingredient handling | ✅ | `builder.addIngredientFromBlob()` |
| Thumbnail embedding | ✅ | `builder.setThumbnailFromBlob()` |
| Signing | ✅ | `builder.sign()` with custom signer callback |
| Soft binding assertions | ✅ | Can add custom assertions like `c2pa.soft-binding` |
| WASM-based processing | ✅ | Runs entirely in browser Web Worker |

### 2.3 Remaining Challenge: Certificate/Key Management

The `sign` callback receives bytes to sign and must return a signature. This requires:

1. **Private Key** - The user needs an ECDSA/RSA private key
2. **Certificate Chain** - X.509 certificate(s) proving identity

**Options for Mosaic:**

| Approach | Pros | Cons |
|----------|------|------|
| **Self-signed certs** | Easy to generate client-side | Not trusted by third parties |
| **User brings own cert** | Professionally trusted | Complex UX, user must have cert |
| **WebAuthn/Passkey signing** | Modern, secure | Not yet standardized for C2PA |
| **Proxy signing service** | User authenticates, service signs | Adds external dependency |

**Recommendation:** Start with self-signed certificates for "personal provenance" use case. Users who want third-party trust can import their own certificates.

---

## 3. Client-Side Watermarking: The Harder Problem

### 3.1 Why Browser Watermarking is Difficult

Robust invisible watermarking (like Imatag/Digimarc) requires:
- DCT (Discrete Cosine Transform) domain manipulation
- Spread-spectrum encoding for robustness
- Perceptual models to ensure invisibility
- Complex extraction algorithms

**Available browser options:**

| Library | Type | Robustness | Status |
|---------|------|------------|--------|
| `steganography.js` | LSB pixel manipulation | ❌ Fragile | Destroyed by JPEG compression |
| Text watermark (zero-width) | Text steganography | N/A | Not for images |
| Custom DCT-WASM | Spread-spectrum | ⚠️ Possible | Would need to build |

### 3.2 Viable Client-Side Watermarking Approaches

**Option A: Simple UUID Embedding (Low Robustness)**
```typescript
// Embed UUID in image metadata (EXIF/XMP) before encryption
// Survives as long as metadata survives
// Lost on social media, but preserved in Mosaic's encrypted storage
```
- **Pros:** Simple, no quality loss
- **Cons:** Not robust to metadata stripping

**Option B: LSB Steganography (Low-Medium Robustness)**
```typescript
// Embed bits in least-significant bits of pixels
// Libraries: steganography.js
```
- **Pros:** Simple implementation
- **Cons:** Destroyed by any re-encoding (JPEG, WebP)

**Option C: DCT-Domain Watermarking (High Robustness)**
```typescript
// Requires custom WASM implementation of DCT watermarking
// Embed in mid-frequency DCT coefficients
// Survives JPEG compression, mild resize
```
- **Pros:** Survives compression
- **Cons:** Significant development effort, no off-the-shelf library

### 3.3 Recommendation for Watermarking

For Mosaic v1, **skip invisible watermarking** and focus on C2PA metadata:

1. C2PA manifest with soft-binding assertion pointing to a hypothetical future watermark
2. Store the "watermark UUID" in the encrypted manifest metadata
3. Later, add DCT watermarking when/if a browser library becomes available

The C2PA manifest itself provides provenance, even without invisible watermarking.

---

## 4. Implementation Architecture for Mosaic

### 4.1 Where It Fits in the Upload Pipeline

```
Current Mosaic Upload Flow:
┌─────────────────────────────────────────────────────────────────┐
│  1. User drops image                                            │
│  2. generateTieredShards() → thumbnail, preview, original       │
│  3. encryptShard() for each tier                                │
│  4. Upload encrypted shards via Tus                             │
│  5. Create manifest with shard references                       │
└─────────────────────────────────────────────────────────────────┘

With C2PA (NEW step between 1 and 2):
┌─────────────────────────────────────────────────────────────────┐
│  1. User drops image                                            │
│  1.5 [NEW] c2pa.builder.sign() → embeds C2PA manifest           │
│  2. generateTieredShards() → thumbnail, preview, original       │
│  3. encryptShard() for each tier                                │
│  4. Upload encrypted shards via Tus                             │
│  5. Create manifest with shard references + C2PA metadata       │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Proposed Implementation (TypeScript)

```typescript
// apps/web/src/lib/c2pa-service.ts
import { createC2pa, type C2paSdk, type Signer } from '@contentauth/c2pa-web';

let c2paInstance: C2paSdk | null = null;

export async function initC2pa(): Promise<C2paSdk> {
  if (!c2paInstance) {
    c2paInstance = await createC2pa({
      wasmSrc: '/c2pa.wasm', // Bundle with app
    });
  }
  return c2paInstance;
}

export interface C2paSigningOptions {
  /** User's display name for claim_generator */
  creatorName?: string;
  /** Optional: User-provided certificate (PEM) */
  certificate?: string;
  /** Optional: User-provided private key (for signing) */
  privateKey?: CryptoKey;
}

export async function signImageWithC2pa(
  imageBlob: Blob,
  options: C2paSigningOptions
): Promise<Blob> {
  const c2pa = await initC2pa();
  
  const builder = await c2pa.builder.fromDefinition({
    claim_generator_info: [{
      name: options.creatorName ?? 'Mosaic User',
      version: '1.0.0'
    }],
    assertions: [
      {
        label: 'c2pa.actions',
        data: {
          actions: [{ action: 'c2pa.created' }],
          allActionsIncluded: true
        }
      }
    ]
  });
  
  // Create signer using WebCrypto
  const signer: Signer = {
    reserveSize: 20000,
    alg: 'Es256',
    sign: async (bytes: Uint8Array) => {
      if (options.privateKey) {
        // Use user-provided key
        const signature = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          options.privateKey,
          bytes
        );
        return new Uint8Array(signature);
      }
      // Generate ephemeral key for self-signed credential
      return await signWithEphemeralKey(bytes);
    }
  };
  
  const signedBytes = await builder.sign(
    signer,
    imageBlob.type,
    imageBlob
  );
  
  return new Blob([signedBytes], { type: imageBlob.type });
}

async function signWithEphemeralKey(bytes: Uint8Array): Promise<Uint8Array> {
  // Generate ephemeral ECDSA key for self-signed credential
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    bytes
  );
  
  return new Uint8Array(signature);
}
```

### 4.3 Integration with Upload Queue

```typescript
// Modification to apps/web/src/lib/upload-queue.ts

private async processTieredUpload(task: UploadTask): Promise<void> {
  // Check if C2PA signing is enabled
  const c2paEnabled = await getUserSetting('enableC2paSigning');
  
  let imageFile = task.file;
  
  if (c2paEnabled && isSupportedImageType(task.file.type)) {
    // Sign with C2PA before processing
    task.currentAction = 'signing'; // New action state
    this.onProgress?.(task);
    
    const signedBlob = await signImageWithC2pa(task.file, {
      creatorName: await getUserDisplayName(),
    });
    
    imageFile = new File([signedBlob], task.file.name, { type: task.file.type });
  }
  
  // Continue with existing flow using signed image
  const tieredResult = await generateTieredShards(imageFile, epochKey, 0);
  // ... rest of upload
}
```

---

## 5. Trade-offs and Limitations

### 5.1 What This Approach Provides

| Feature | Status | Notes |
|---------|--------|-------|
| **Embedded C2PA manifest** | ✅ | In original shard, survives download |
| **Zero-knowledge preserved** | ✅ | All signing happens before encryption |
| **Provenance on export** | ✅ | Downloaded images have C2PA metadata |
| **Third-party verification** | ⚠️ | Only with trusted certificate |
| **Robust watermarking** | ❌ | Not included in v1 |

### 5.2 Limitations

1. **Self-Signed Trust**
   - Without a CA-issued certificate, third parties can't verify the signer's identity
   - They can verify the image hasn't been modified since signing
   - Suitable for "personal provenance" but not legal proof

2. **Certificate UX**
   - Power users can import their own certificates
   - Average users get self-signed credentials (still useful for integrity)

3. **No Robust Watermarking**
   - Social media will strip C2PA metadata
   - Without invisible watermark, stripped images can't be traced back
   - Future enhancement: Add DCT watermarking when library available

4. **Processing Overhead**
   - C2PA signing adds ~100-500ms per image
   - Acceptable for upload flow, might need optimization for batch

---

## 6. Alternative: Metadata-Only C2PA (Simpler)

If full signing is too complex for v1, consider a simpler approach:

### 6.1 Store C2PA Data in Mosaic's Encrypted Manifest

Instead of embedding C2PA in the image file, store provenance data in Mosaic's own encrypted manifest:

```typescript
interface PhotoMetadata {
  // Existing fields...
  captureTime?: number;
  width: number;
  height: number;
  
  // NEW: C2PA-inspired provenance
  provenance?: {
    creator?: string;
    createdAt: string;
    device?: string;
    software?: string;
    actions: Array<{
      action: string;
      when: string;
    }>;
    // Hash of original pixels for integrity check
    originalHash: string;
  };
}
```

### 6.2 Export with C2PA

When user exports/downloads, generate C2PA manifest at that point:

```typescript
async function downloadWithC2pa(photo: PhotoMeta, decryptedBlob: Blob): Promise<Blob> {
  const c2pa = await initC2pa();
  const builder = await c2pa.builder.fromDefinition({
    claim_generator_info: [{ name: 'Mosaic', version: '1.0.0' }],
    assertions: [{
      label: 'c2pa.actions',
      data: {
        actions: photo.provenance?.actions ?? [{ action: 'c2pa.created' }]
      }
    }]
  });
  
  const signedBytes = await builder.sign(signer, decryptedBlob.type, decryptedBlob);
  return new Blob([signedBytes], { type: decryptedBlob.type });
}
```

**Advantage:** Simpler implementation, provenance data stored in Mosaic's existing encrypted storage.

---

## 7. Recommendations

### For Mosaic v1: Optional Feature (Low Priority)

**Rationale:**

1. ✅ Zero-knowledge is preserved (client-side signing)
2. ✅ Technology now exists (`c2pa-js` with WASM signing)
3. ⚠️ Certificate management UX is complex
4. ⚠️ Without trusted certs, value is limited to personal integrity checks
5. ❓ User demand for C2PA in encrypted personal galleries is unclear

**Recommended Approach:**

1. **Phase 1 (v1.x):** Document pre-processing workflow
   - Users can sign images externally before upload
   - C2PA metadata is preserved through encryption/decryption

2. **Phase 2 (v2.0):** Add optional client-side signing
   - Opt-in setting: "Sign images with Content Credentials"
   - Self-signed certificates for personal provenance
   - Power user option to import custom certificates

3. **Phase 3 (Future):** Robust watermarking
   - When browser DCT watermarking library becomes available
   - Or build custom WASM implementation

### For Users Who Need Copyright Protection Today

> **Using C2PA with Mosaic (Pre-Processing):**
>
> Mosaic is a zero-knowledge encrypted gallery. While we're working on built-in C2PA support, you can protect your images before upload:
>
> 1. Use Adobe Photoshop/Lightroom to add Content Credentials before export
> 2. Use a dedicated C2PA service (e.g., contentcredentials.org)
> 3. Upload the already-protected images to Mosaic
>
> The C2PA manifest will be preserved in the encrypted shards and restored on download.

---

## 8. Conclusion

**Updated Verdict:** Client-side C2PA is now technically feasible thanks to `c2pa-js` v0.4.0+ adding browser-based signing via WASM.

| Original Proposal | Mosaic Reality |
|-------------------|----------------|
| ❌ Server-side signing | ✅ Client-side signing possible |
| ❌ Imatag API watermarking | ⚠️ No browser alternative yet |
| ❌ Destroys zero-knowledge | ✅ Zero-knowledge preserved |

**The path forward:**

1. **Short term:** Document external pre-processing workflow
2. **Medium term:** Implement optional client-side C2PA with self-signed certs
3. **Long term:** Add robust watermarking when browser library available

The zero-knowledge architecture is NOT a blocker for C2PA—client-side signing before encryption works perfectly with Mosaic's design.

---

## References

1. [Mosaic ARCHITECTURE.md](../ARCHITECTURE.md)
2. [Mosaic SECURITY.md](../SECURITY.md)
3. [C2PA Specification](https://c2pa.org/specifications/)
4. [@contentauth/c2pa-js (now with signing!)](https://github.com/contentauth/c2pa-js)
5. [c2pa-web package documentation](https://github.com/contentauth/c2pa-js/tree/main/packages/c2pa-web)
6. [Imatag API Documentation](https://www.imatag.com/api-documentation/) (server-side only)
