/* @ts-self-types="./mosaic_wasm.d.ts" */

/**
 * WASM-bindgen class for account-key handle status results.
 */
export class AccountKeyHandleStatusResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AccountKeyHandleStatusResult.prototype);
        obj.__wbg_ptr = ptr;
        AccountKeyHandleStatusResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AccountKeyHandleStatusResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_accountkeyhandlestatusresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.accountkeyhandlestatusresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Whether the handle is currently open.
     * @returns {boolean}
     */
    get isOpen() {
        const ret = wasm.accountkeyhandlestatusresult_isOpen(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) AccountKeyHandleStatusResult.prototype[Symbol.dispose] = AccountKeyHandleStatusResult.prototype.free;

/**
 * WASM-bindgen class for account unlock results.
 */
export class AccountUnlockResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AccountUnlockResult.prototype);
        obj.__wbg_ptr = ptr;
        AccountUnlockResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AccountUnlockResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_accountunlockresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.accountunlockresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Opaque Rust-owned account-key handle.
     * @returns {bigint}
     */
    get handle() {
        const ret = wasm.accountunlockresult_handle(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
}
if (Symbol.dispose) AccountUnlockResult.prototype[Symbol.dispose] = AccountUnlockResult.prototype.free;

/**
 * WASM-bindgen class for byte-array results.
 */
export class BytesResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(BytesResult.prototype);
        obj.__wbg_ptr = ptr;
        BytesResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BytesResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_bytesresult_free(ptr, 0);
    }
    /**
     * Public bytes or signature bytes.
     * @returns {Uint8Array}
     */
    get bytes() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.bytesresult_bytes(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.bytesresult_code(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) BytesResult.prototype[Symbol.dispose] = BytesResult.prototype.free;

/**
 * WASM-bindgen class for public crypto/domain golden-vector snapshots.
 */
export class CryptoDomainGoldenVectorSnapshot {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(CryptoDomainGoldenVectorSnapshot.prototype);
        obj.__wbg_ptr = ptr;
        CryptoDomainGoldenVectorSnapshotFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CryptoDomainGoldenVectorSnapshotFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_cryptodomaingoldenvectorsnapshot_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.cryptodomaingoldenvectorsnapshot_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Parsed envelope epoch ID.
     * @returns {number}
     */
    get envelopeEpochId() {
        const ret = wasm.cryptodomaingoldenvectorsnapshot_envelopeEpochId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Serialized 64-byte shard envelope header vector.
     * @returns {Uint8Array}
     */
    get envelopeHeader() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.cryptodomaingoldenvectorsnapshot_envelopeHeader(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parsed envelope nonce bytes.
     * @returns {Uint8Array}
     */
    get envelopeNonce() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.cryptodomaingoldenvectorsnapshot_envelopeNonce(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parsed envelope shard index.
     * @returns {number}
     */
    get envelopeShardIndex() {
        const ret = wasm.cryptodomaingoldenvectorsnapshot_envelopeShardIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Parsed envelope tier byte.
     * @returns {number}
     */
    get envelopeTier() {
        const ret = wasm.cryptodomaingoldenvectorsnapshot_envelopeTier(this.__wbg_ptr);
        return ret;
    }
    /**
     * X25519 recipient public key bytes.
     * @returns {Uint8Array}
     */
    get identityEncryptionPubkey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.cryptodomaingoldenvectorsnapshot_identityEncryptionPubkey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Fixed public identity signing message bytes.
     * @returns {Uint8Array}
     */
    get identityMessage() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.cryptodomaingoldenvectorsnapshot_identityMessage(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Ed25519 detached identity signature bytes.
     * @returns {Uint8Array}
     */
    get identitySignature() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.cryptodomaingoldenvectorsnapshot_identitySignature(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Ed25519 identity public key bytes.
     * @returns {Uint8Array}
     */
    get identitySigningPubkey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.cryptodomaingoldenvectorsnapshot_identitySigningPubkey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Canonical manifest transcript vector bytes.
     * @returns {Uint8Array}
     */
    get manifestTranscript() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.cryptodomaingoldenvectorsnapshot_manifestTranscript(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) CryptoDomainGoldenVectorSnapshot.prototype[Symbol.dispose] = CryptoDomainGoldenVectorSnapshot.prototype.free;

/**
 * WASM-bindgen class for decrypted shard results.
 */
export class DecryptedShardResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(DecryptedShardResult.prototype);
        obj.__wbg_ptr = ptr;
        DecryptedShardResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecryptedShardResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decryptedshardresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.decryptedshardresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Client-local plaintext bytes on successful decryption.
     * @returns {Uint8Array}
     */
    get plaintext() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.decryptedshardresult_plaintext(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) DecryptedShardResult.prototype[Symbol.dispose] = DecryptedShardResult.prototype.free;

/**
 * WASM-bindgen class for encrypted shard results.
 */
export class EncryptedShardResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EncryptedShardResult.prototype);
        obj.__wbg_ptr = ptr;
        EncryptedShardResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EncryptedShardResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_encryptedshardresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.encryptedshardresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Full encrypted shard envelope bytes.
     * @returns {Uint8Array}
     */
    get envelopeBytes() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.encryptedshardresult_envelopeBytes(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Base64url SHA-256 digest of the full envelope bytes.
     * @returns {string}
     */
    get sha256() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.encryptedshardresult_sha256(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) EncryptedShardResult.prototype[Symbol.dispose] = EncryptedShardResult.prototype.free;

/**
 * WASM-bindgen class for epoch-key handle results.
 */
export class EpochKeyHandleResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EpochKeyHandleResult.prototype);
        obj.__wbg_ptr = ptr;
        EpochKeyHandleResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EpochKeyHandleResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_epochkeyhandleresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.epochkeyhandleresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Epoch identifier associated with this handle.
     * @returns {number}
     */
    get epochId() {
        const ret = wasm.epochkeyhandleresult_epochId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Opaque Rust-owned epoch-key handle.
     * @returns {bigint}
     */
    get handle() {
        const ret = wasm.epochkeyhandleresult_handle(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Wrapped epoch seed bytes returned on creation.
     * @returns {Uint8Array}
     */
    get wrappedEpochSeed() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.epochkeyhandleresult_wrappedEpochSeed(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) EpochKeyHandleResult.prototype[Symbol.dispose] = EpochKeyHandleResult.prototype.free;

/**
 * WASM-bindgen class for epoch-key handle status results.
 */
export class EpochKeyHandleStatusResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EpochKeyHandleStatusResult.prototype);
        obj.__wbg_ptr = ptr;
        EpochKeyHandleStatusResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EpochKeyHandleStatusResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_epochkeyhandlestatusresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.epochkeyhandlestatusresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Whether the handle is currently open.
     * @returns {boolean}
     */
    get isOpen() {
        const ret = wasm.epochkeyhandlestatusresult_isOpen(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) EpochKeyHandleStatusResult.prototype[Symbol.dispose] = EpochKeyHandleStatusResult.prototype.free;

/**
 * WASM-bindgen class for header parse results.
 */
export class HeaderResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(HeaderResult.prototype);
        obj.__wbg_ptr = ptr;
        HeaderResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HeaderResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_headerresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.headerresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Parsed epoch ID when parsing succeeds.
     * @returns {number}
     */
    get epochId() {
        const ret = wasm.headerresult_epochId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Parsed nonce when parsing succeeds.
     * @returns {Uint8Array}
     */
    get nonce() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.headerresult_nonce(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parsed shard index when parsing succeeds.
     * @returns {number}
     */
    get shardIndex() {
        const ret = wasm.headerresult_shardIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Parsed tier byte when parsing succeeds.
     * @returns {number}
     */
    get tier() {
        const ret = wasm.headerresult_tier(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) HeaderResult.prototype[Symbol.dispose] = HeaderResult.prototype.free;

/**
 * WASM-bindgen class for identity handle results.
 */
export class IdentityHandleResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(IdentityHandleResult.prototype);
        obj.__wbg_ptr = ptr;
        IdentityHandleResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IdentityHandleResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_identityhandleresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.identityhandleresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * X25519 recipient public key.
     * @returns {Uint8Array}
     */
    get encryptionPubkey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.identityhandleresult_encryptionPubkey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Opaque Rust-owned identity handle.
     * @returns {bigint}
     */
    get handle() {
        const ret = wasm.identityhandleresult_handle(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Ed25519 public identity key.
     * @returns {Uint8Array}
     */
    get signingPubkey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.identityhandleresult_signingPubkey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Wrapped identity seed bytes returned on creation.
     * @returns {Uint8Array}
     */
    get wrappedSeed() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.identityhandleresult_wrappedSeed(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) IdentityHandleResult.prototype[Symbol.dispose] = IdentityHandleResult.prototype.free;

/**
 * WASM-bindgen class for progress events.
 */
export class ProgressEvent {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProgressEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_progressevent_free(ptr, 0);
    }
    /**
     * Completed operation steps.
     * @returns {number}
     */
    get completedSteps() {
        const ret = wasm.progressevent_completedSteps(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Total operation steps.
     * @returns {number}
     */
    get totalSteps() {
        const ret = wasm.progressevent_totalSteps(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) ProgressEvent.prototype[Symbol.dispose] = ProgressEvent.prototype.free;

/**
 * WASM-bindgen class for progress results.
 */
export class ProgressResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProgressResult.prototype);
        obj.__wbg_ptr = ptr;
        ProgressResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProgressResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_progressresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.progressresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Flattened completed/total pairs for low-friction JS marshalling.
     * @returns {Uint32Array}
     */
    get eventPairs() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.progressresult_eventPairs(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) ProgressResult.prototype[Symbol.dispose] = ProgressResult.prototype.free;

/**
 * Returns account-key handle status through WASM.
 * @param {bigint} handle
 * @returns {AccountKeyHandleStatusResult}
 */
export function accountKeyHandleIsOpen(handle) {
    const ret = wasm.accountKeyHandleIsOpen(handle);
    return AccountKeyHandleStatusResult.__wrap(ret);
}

/**
 * Builds canonical metadata sidecar bytes through WASM.
 * @param {Uint8Array} album_id
 * @param {Uint8Array} photo_id
 * @param {number} epoch_id
 * @param {Uint8Array} encoded_fields
 * @returns {BytesResult}
 */
export function canonicalMetadataSidecarBytes(album_id, photo_id, epoch_id, encoded_fields) {
    const ptr0 = passArray8ToWasm0(album_id, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(photo_id, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(encoded_fields, wasm.__wbindgen_export3);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.canonicalMetadataSidecarBytes(ptr0, len0, ptr1, len1, epoch_id, ptr2, len2);
    return BytesResult.__wrap(ret);
}

/**
 * Closes an account-key handle through WASM.
 * @param {bigint} handle
 * @returns {number}
 */
export function closeAccountKeyHandle(handle) {
    const ret = wasm.closeAccountKeyHandle(handle);
    return ret;
}

/**
 * Closes an epoch-key handle through WASM.
 * @param {bigint} handle
 * @returns {number}
 */
export function closeEpochKeyHandle(handle) {
    const ret = wasm.closeEpochKeyHandle(handle);
    return ret;
}

/**
 * Closes an identity handle through WASM.
 * @param {bigint} handle
 * @returns {number}
 */
export function closeIdentityHandle(handle) {
    const ret = wasm.closeIdentityHandle(handle);
    return ret;
}

/**
 * Creates a new epoch-key handle through WASM.
 * @param {bigint} account_key_handle
 * @param {number} epoch_id
 * @returns {EpochKeyHandleResult}
 */
export function createEpochKeyHandle(account_key_handle, epoch_id) {
    const ret = wasm.createEpochKeyHandle(account_key_handle, epoch_id);
    return EpochKeyHandleResult.__wrap(ret);
}

/**
 * Creates a new identity handle through the generated WASM binding surface.
 * @param {bigint} account_key_handle
 * @returns {IdentityHandleResult}
 */
export function createIdentityHandle(account_key_handle) {
    const ret = wasm.createIdentityHandle(account_key_handle);
    return IdentityHandleResult.__wrap(ret);
}

/**
 * Returns deterministic public crypto/domain golden vectors through WASM.
 * @returns {CryptoDomainGoldenVectorSnapshot}
 */
export function cryptoDomainGoldenVectorSnapshot() {
    const ret = wasm.cryptoDomainGoldenVectorSnapshot();
    return CryptoDomainGoldenVectorSnapshot.__wrap(ret);
}

/**
 * Decrypts shard envelope bytes with an epoch-key handle through WASM.
 * @param {bigint} handle
 * @param {Uint8Array} envelope_bytes
 * @returns {DecryptedShardResult}
 */
export function decryptShardWithEpochHandle(handle, envelope_bytes) {
    const ptr0 = passArray8ToWasm0(envelope_bytes, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decryptShardWithEpochHandle(handle, ptr0, len0);
    return DecryptedShardResult.__wrap(ret);
}

/**
 * Encrypts metadata sidecar bytes with an epoch handle through WASM.
 * @param {bigint} handle
 * @param {Uint8Array} album_id
 * @param {Uint8Array} photo_id
 * @param {number} epoch_id
 * @param {Uint8Array} encoded_fields
 * @param {number} shard_index
 * @returns {EncryptedShardResult}
 */
export function encryptMetadataSidecarWithEpochHandle(handle, album_id, photo_id, epoch_id, encoded_fields, shard_index) {
    const ptr0 = passArray8ToWasm0(album_id, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(photo_id, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(encoded_fields, wasm.__wbindgen_export3);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.encryptMetadataSidecarWithEpochHandle(handle, ptr0, len0, ptr1, len1, epoch_id, ptr2, len2, shard_index);
    return EncryptedShardResult.__wrap(ret);
}

/**
 * Encrypts shard bytes with an epoch-key handle through WASM.
 * @param {bigint} handle
 * @param {Uint8Array} plaintext
 * @param {number} shard_index
 * @param {number} tier_byte
 * @returns {EncryptedShardResult}
 */
export function encryptShardWithEpochHandle(handle, plaintext, shard_index, tier_byte) {
    const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encryptShardWithEpochHandle(handle, ptr0, len0, shard_index, tier_byte);
    return EncryptedShardResult.__wrap(ret);
}

/**
 * Returns epoch-key handle status through WASM.
 * @param {bigint} handle
 * @returns {EpochKeyHandleStatusResult}
 */
export function epochKeyHandleIsOpen(handle) {
    const ret = wasm.epochKeyHandleIsOpen(handle);
    return EpochKeyHandleStatusResult.__wrap(ret);
}

/**
 * Returns an identity handle's X25519 public key through WASM.
 * @param {bigint} handle
 * @returns {BytesResult}
 */
export function identityEncryptionPubkey(handle) {
    const ret = wasm.identityEncryptionPubkey(handle);
    return BytesResult.__wrap(ret);
}

/**
 * Returns an identity handle's Ed25519 public key through WASM.
 * @param {bigint} handle
 * @returns {BytesResult}
 */
export function identitySigningPubkey(handle) {
    const ret = wasm.identitySigningPubkey(handle);
    return BytesResult.__wrap(ret);
}

/**
 * Opens an epoch-key handle through WASM.
 * @param {Uint8Array} wrapped_epoch_seed
 * @param {bigint} account_key_handle
 * @param {number} epoch_id
 * @returns {EpochKeyHandleResult}
 */
export function openEpochKeyHandle(wrapped_epoch_seed, account_key_handle, epoch_id) {
    const ptr0 = passArray8ToWasm0(wrapped_epoch_seed, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.openEpochKeyHandle(ptr0, len0, account_key_handle, epoch_id);
    return EpochKeyHandleResult.__wrap(ret);
}

/**
 * Opens an identity handle through the generated WASM binding surface.
 * @param {Uint8Array} wrapped_identity_seed
 * @param {bigint} account_key_handle
 * @returns {IdentityHandleResult}
 */
export function openIdentityHandle(wrapped_identity_seed, account_key_handle) {
    const ptr0 = passArray8ToWasm0(wrapped_identity_seed, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.openIdentityHandle(ptr0, len0, account_key_handle);
    return IdentityHandleResult.__wrap(ret);
}

/**
 * Parses a shard envelope header through the generated WASM binding surface.
 * @param {Uint8Array} bytes
 * @returns {HeaderResult}
 */
export function parseEnvelopeHeader(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parseEnvelopeHeader(ptr0, len0);
    return HeaderResult.__wrap(ret);
}

/**
 * Runs the progress probe through the generated WASM binding surface.
 * @param {number} total_steps
 * @param {bigint} cancel_after
 * @returns {ProgressResult}
 */
export function progressProbe(total_steps, cancel_after) {
    const ret = wasm.progressProbe(total_steps, cancel_after);
    return ProgressResult.__wrap(ret);
}

/**
 * Signs manifest transcript bytes through WASM.
 * @param {bigint} handle
 * @param {Uint8Array} transcript_bytes
 * @returns {BytesResult}
 */
export function signManifestWithIdentity(handle, transcript_bytes) {
    const ptr0 = passArray8ToWasm0(transcript_bytes, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.signManifestWithIdentity(handle, ptr0, len0);
    return BytesResult.__wrap(ret);
}

/**
 * Unwraps an account key through the generated WASM binding surface.
 * @param {Uint8Array} password
 * @param {Uint8Array} user_salt
 * @param {Uint8Array} account_salt
 * @param {Uint8Array} wrapped_account_key
 * @param {number} kdf_memory_kib
 * @param {number} kdf_iterations
 * @param {number} kdf_parallelism
 * @returns {AccountUnlockResult}
 */
export function unlockAccountKey(password, user_salt, account_salt, wrapped_account_key, kdf_memory_kib, kdf_iterations, kdf_parallelism) {
    const ptr0 = passArray8ToWasm0(password, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(user_salt, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(account_salt, wasm.__wbindgen_export3);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(wrapped_account_key, wasm.__wbindgen_export3);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.unlockAccountKey(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, kdf_memory_kib, kdf_iterations, kdf_parallelism);
    return AccountUnlockResult.__wrap(ret);
}

/**
 * Verifies manifest transcript bytes through WASM.
 * @param {Uint8Array} transcript_bytes
 * @param {Uint8Array} signature
 * @param {Uint8Array} public_key
 * @returns {number}
 */
export function verifyManifestWithIdentity(transcript_bytes, signature, public_key) {
    const ptr0 = passArray8ToWasm0(transcript_bytes, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(public_key, wasm.__wbindgen_export3);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.verifyManifestWithIdentity(ptr0, len0, ptr1, len1, ptr2, len2);
    return ret;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6b64449b9b9ed33c: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_getRandomValues_76dfc69825c9c552: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./mosaic_wasm_bg.js": import0,
    };
}

const AccountKeyHandleStatusResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_accountkeyhandlestatusresult_free(ptr >>> 0, 1));
const AccountUnlockResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_accountunlockresult_free(ptr >>> 0, 1));
const BytesResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_bytesresult_free(ptr >>> 0, 1));
const CryptoDomainGoldenVectorSnapshotFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_cryptodomaingoldenvectorsnapshot_free(ptr >>> 0, 1));
const DecryptedShardResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decryptedshardresult_free(ptr >>> 0, 1));
const EncryptedShardResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_encryptedshardresult_free(ptr >>> 0, 1));
const EpochKeyHandleResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_epochkeyhandleresult_free(ptr >>> 0, 1));
const EpochKeyHandleStatusResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_epochkeyhandlestatusresult_free(ptr >>> 0, 1));
const HeaderResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_headerresult_free(ptr >>> 0, 1));
const IdentityHandleResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_identityhandleresult_free(ptr >>> 0, 1));
const ProgressEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_progressevent_free(ptr >>> 0, 1));
const ProgressResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_progressresult_free(ptr >>> 0, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('mosaic_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
