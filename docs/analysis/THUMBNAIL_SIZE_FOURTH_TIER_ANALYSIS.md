# Thumbnail Size & Fourth Tier Analysis

**Date:** January 2026  
**Status:** Investigation Complete

## Executive Summary

This analysis evaluates whether to increase thumbnail sizes and/or introduce a fourth tier to the current 3-tier system. The current system works well for most use cases, but there are opportunities for optimization—particularly around HiDPI displays and manifest size reduction.

---

## Current System Overview

### Three-Tier Architecture

| Tier | Name | Max Dimension | Quality | Max Size | Purpose |
|------|------|---------------|---------|----------|---------|
| 1 | **Thumbnail** | 300px | 80% | 50KB | Grid gallery view |
| 2 | **Preview** | 1200px | 85% | 500KB | Lightbox/detail view |
| 3 | **Original** | Unchanged | Original | 6MB/chunk | Download/full resolution |

### Current Display Characteristics

- **Target row height:** 220px (configurable)
- **Maximum row height:** ~330px (1.5× multiplier)
- **Typical CSS display size:** 150-300px per thumbnail
- **Device pixel ratios:** 1× (standard), 2× (Retina/HiDPI), 3× (high-end mobile)

### Data Flow

```
Upload → [BlurHash] → [Thumbnail 300px] → [Preview 1200px] → [Original]
                 ↓              ↓
         Manifest (~30 chars)   Manifest (~15-40KB base64)
                                      +
                               Shard (encrypted, ~5-50KB)
```

---

## Problem Statement

### Issue 1: HiDPI Display Quality

On 2× Retina displays, a thumbnail displayed at 200×200 CSS pixels actually renders at 400×400 physical pixels. The current 300px max dimension can appear slightly soft on:
- MacBooks (2× DPR)
- Modern smartphones (2-3× DPR)
- 4K monitors at 1.5-2× scaling

### Issue 2: Manifest Bloat

Each photo's embedded base64 thumbnail adds **~15-40KB** to the manifest. For an album with 1,000 photos, this means:
- **15-40MB** of manifest data to download/parse
- Significant OPFS storage usage
- Slower initial album load times

### Issue 3: Preview Gap

The jump from 300px thumbnail → 1200px preview is large (4× difference). When opening the lightbox, there's a noticeable delay loading the 85KB-500KB preview shard.

---

## Proposed Solutions

### Option A: Increase Thumbnail Size (Simple)

Change thumbnail max dimension from 300px to 400-500px.

| Change | Current | Proposed |
|--------|---------|----------|
| Max dimension | 300px | 450px |
| File size | 15-40KB | 25-70KB |
| Quality | 80% | 80% |

**Pros:**
- Simple code change (one constant)
- Better HiDPI quality
- No architectural changes

**Cons:**
- ~2× larger manifest size
- More bandwidth for initial sync
- Existing photos won't benefit (migration required)

### Option B: Split Embedded vs Shard Thumbnails

Use a **smaller** embedded thumbnail (for manifest) and **larger** shard thumbnail.

| Component | Dimension | Storage |
|-----------|-----------|---------|
| Embedded (manifest) | 150-200px | ~5-10KB base64 |
| Shard thumbnail | 400-500px | ~40-80KB shard |

**Pros:**
- Smaller manifests (~50% reduction)
- Better gallery quality from shard
- Instant blur → small thumb → sharp thumb progression

**Cons:**
- Requires loading shard for sharp thumbnails
- More network requests in gallery

### Option C: Four-Tier System

Introduce a fourth tier between thumbnail and preview.

| Tier | Name | Max Dimension | Purpose |
|------|------|---------------|---------|
| 1 | **Micro** | 150px | Embedded in manifest, fast grid |
| 2 | **Thumb** | 400px | HiDPI gallery grid |
| 3 | **Preview** | 1200px | Lightbox/detail view |
| 4 | **Original** | Full | Download/editing |

**Pros:**
- Optimal size for each use case
- Smaller manifests
- Better HiDPI support
- Smoother progressive loading

**Cons:**
- More complexity (4 encryption keys per epoch)
- More shard uploads (4 instead of 3)
- More storage usage
- Breaking change requiring migration

### Option D: Adaptive Thumbnails (Recommended)

Keep 3 tiers but optimize embedded thumbnails separately.

| Component | Current | Proposed |
|-----------|---------|----------|
| BlurHash | ~30 chars | ~30 chars (unchanged) |
| Embedded | 300px, ~25KB | 150px, ~5KB |
| Thumb shard | 300px | 450px |
| Preview shard | 1200px | 1200px |
| Original | Full | Full |

**Key changes:**
1. Reduce embedded thumbnail to 150px (manifest size reduction)
2. Increase thumb shard to 450px (HiDPI quality)
3. Progressive loading: BlurHash → Embedded 150px → Shard 450px

---

## Detailed Impact Analysis

### Storage Impact (Per Photo)

| Component | Current | Option A | Option B | Option C | Option D |
|-----------|---------|----------|----------|----------|----------|
| BlurHash | ~30B | ~30B | ~30B | ~30B | ~30B |
| Embedded | ~25KB | ~50KB | ~7KB | ~7KB | ~7KB |
| Thumb shard | ~25KB | ~50KB | ~50KB | — | ~50KB |
| Micro shard | — | — | — | ~7KB | — |
| Preview shard | ~150KB | ~150KB | ~150KB | ~150KB | ~150KB |
| Original | varies | varies | varies | varies | varies |
| **Total additional** | — | **+50KB** | **+18KB** | **+7KB** | **+25KB** |

### Manifest Size (1,000 Photos)

| Scenario | Current | Option A | Option B/C/D |
|----------|---------|----------|--------------|
| Embedded thumbnails | ~25MB | ~50MB | ~7MB |
| Sync download | ~25MB | ~50MB | ~7MB |
| OPFS usage | ~25MB | ~50MB | ~7MB |

### Quality vs. Display Size Matrix

| CSS Size | Physical @1× | Physical @2× | 300px Thumb | 450px Thumb |
|----------|--------------|--------------|-------------|-------------|
| 150px | 150px | 300px | ✅ Sharp | ✅ Sharp |
| 200px | 200px | 400px | ⚠️ 75% | ✅ Sharp |
| 250px | 250px | 500px | ⚠️ 60% | ⚠️ 90% |
| 300px | 300px | 600px | ⚠️ 50% | ⚠️ 75% |

---

## Implementation Complexity

| Option | Code Changes | Migration | Breaking |
|--------|--------------|-----------|----------|
| A | 1 constant | Optional | No |
| B | Moderate | Required | Partial |
| C | Extensive | Required | Yes |
| D | Moderate | Required | No |

### Option D Implementation Details

1. **Thumbnail generator changes:**
   ```typescript
   const EMBEDDED_MAX_SIZE = 150;  // For manifest (was 300)
   const THUMB_MAX_SIZE = 450;     // For shard (was 300)
   ```

2. **Upload queue changes:**
   - Generate 150px embedded thumbnail for manifest
   - Generate 450px thumbnail for tier 1 shard

3. **Display changes:**
   - Gallery uses embedded 150px → loads 450px shard if in viewport
   - Lightbox uses 450px thumb → loads 1200px preview

4. **Migration strategy:**
   - New photos get new sizes
   - Old photos continue working (300px is still good)
   - Optional: background migration during idle

---

## Recommendations

### Short Term (Recommended): Option D - Adaptive Thumbnails

1. **Reduce embedded thumbnail to 150px**
   - Immediate manifest size savings (~70%)
   - No breaking changes
   - Existing photos still work

2. **Increase thumb shard to 450px**
   - Better HiDPI quality
   - Smooth progression: 150px → 450px → 1200px

3. **Add optional shard loading for grid**
   - Only load 450px shard for visible photos
   - Background prefetch for adjacent photos

### Long Term: Consider Option C (4-Tier) Only If:
- Storage costs become negligible
- User demand for HiDPI exceeds current quality
- Major version allows breaking changes

---

## Decision Matrix

| Factor | Weight | Option A | Option B | Option C | Option D |
|--------|--------|----------|----------|----------|----------|
| Manifest size | 25% | ❌ | ✅ | ✅ | ✅ |
| HiDPI quality | 25% | ✅ | ✅ | ✅ | ✅ |
| Complexity | 20% | ✅✅ | ⚠️ | ❌ | ⚠️ |
| Migration | 15% | ✅ | ⚠️ | ❌ | ⚠️ |
| Storage cost | 15% | ❌ | ⚠️ | ❌ | ⚠️ |
| **Total Score** | | 55% | 65% | 45% | **75%** |

---

## Conclusion

**Option D (Adaptive Thumbnails)** provides the best balance:
- 70% manifest size reduction
- HiDPI quality improvement
- No breaking changes
- Reasonable implementation effort

A fourth tier (Option C) adds significant complexity without proportional benefit. The 150px → 450px → 1200px progression is smooth enough for most use cases.

---

## Appendix: Dimension Guidelines by Display

| Device | DPR | Gallery Row Height | Optimal Thumb | Current Coverage |
|--------|-----|-------------------|---------------|------------------|
| MacBook | 2× | 220px = 440px physical | 440px | 68% (300px) |
| iPhone | 3× | 220px = 660px physical | 660px | 45% (300px) |
| 1080p | 1× | 220px = 220px physical | 220px | 100% (300px) |
| 4K@150% | 1.5× | 220px = 330px physical | 330px | 91% (300px) |

With 450px thumbnails:
| Device | Coverage |
|--------|----------|
| MacBook (2×) | 100% |
| iPhone (3×) | 68% |
| 1080p (1×) | 100% |
| 4K@150% | 100% |
