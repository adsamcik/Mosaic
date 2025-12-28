# Mutation Testing TODO

Tracking surviving mutants from Stryker mutation testing.

## Progress Summary

| File | Initial | Current | Killed | Survived | Status |
|------|---------|---------|--------|----------|--------|
| envelope.ts | 61.18% | 93.75% | 89 | 6 | ✅ |
| epochs.ts | 95.92% | 96.30% | 78 | 3 | ✅ |
| identity.ts | 55.81% | 95.35% | 41 | 2 | ✅ |
| keybox.ts | 55.26% | **100%** | 38 | 0 | ✅ |
| keychain.ts | 59.26% | 96.30% | 52 | 2 | ✅ |
| link-sharing.ts | n/a | 80.23% | 69 | 17 | 🟡 |
| sharing.ts | 70.45% | 93.18% | 41 | 3 | ✅ |
| signer.ts | 45.90% | 80.33% | 49 | 12 | 🟡 |
| utils.ts | 91.30% | **100%** | 23 | 0 | ✅ |
| **Overall** | **64.48%** | **91.44%** | **480** | **45** | ✅ |

---

## Remaining Survivors

### envelope.ts (6 survived)

- [x] `L212`: Key length validation bypass - KILLED
- [x] `L225`: Empty ciphertext validation - KILLED
- [x] `L292`: Hash verification bypass - KILLED
- [ ] `L68`: `view.setUint32(OFFSET_EPOCH_ID, epochId, true)` → `false` (endianness)
- [ ] `L71`: `view.setUint32(OFFSET_SHARD_ID, shardId, true)` → `false` (endianness)
- [ ] `L93`: `if (envelope.length < ENVELOPE_HEADER_SIZE)` → `if (false)`

### epochs.ts (3 survived)

- [x] `L147`: typeof check mutation - KILLED
- [x] `L147`: Boundary condition (< vs <=) - KILLED
- [ ] Minor mutations in tier key derivation

### identity.ts (2 survived)

- [x] All validation bypass mutants - KILLED
- [x] Error message mutants - KILLED
- [x] Catch block coverage - KILLED
- [ ] Minor mutations remaining

### keychain.ts (2 survived)

- [x] Context string mutations - KILLED
- [x] Validation bypass mutants - KILLED
- [x] Error message mutants - KILLED
- [ ] Minor mutations remaining

### sharing.ts (3 survived)

- [x] Recipient key validation - KILLED
- [x] epochId boundary condition - KILLED
- [x] JSON parse error handling - KILLED
- [ ] Minor mutations remaining

### signer.ts (12 survived) 🔴

- [x] Context string mutation - KILLED
- [x] Key length validations - KILLED
- [ ] `L65`: `if (signature.length !== SIGNATURE_LENGTH)` → `if (false)`
- [ ] `L68`: `if (signPublicKey.length !== PUBLIC_KEY_LENGTH)` → `if (false)`
- [ ] `L177`: Signature length validation block removed
- [ ] `L180`: Public key length validation bypass and block removed

### link-sharing.ts (17 survived) 🔴

This is a new file not in the original mutation run. Needs attention.

---

## Completed Work

### Phase 1: Initial Assessment ✅

Created mutation testing infrastructure with Stryker.

### Phase 2: Systematic Mutant Killing ✅

Dispatched subagents to address each file:

- envelope.ts: Added key length, empty data, and hash verification tests
- epochs.ts: Added typeof and boundary condition tests
- identity.ts: Added validation, error message, and catch block tests
- keybox.ts: Added boundary tests and error message verification
- keychain.ts: Added context determinism and validation tests
- sharing.ts: Added recipient validation and boundary tests
- signer.ts: Added domain separation and validation tests
- utils.ts: Added sha256Sync and fromBytes tests

### Results

- **Initial score**: 64.48%
- **Final score**: 91.44%
- **Improvement**: +26.96 percentage points
- **Mutants killed**: 480 (up from 255)
- **100% coverage achieved**: keybox.ts, utils.ts
