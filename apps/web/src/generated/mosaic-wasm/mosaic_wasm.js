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
 * WASM-bindgen class for auth keypair derivation results.
 */
export class AuthKeypairResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AuthKeypairResult.prototype);
        obj.__wbg_ptr = ptr;
        AuthKeypairResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AuthKeypairResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_authkeypairresult_free(ptr, 0);
    }
    /**
     * 32-byte Ed25519 LocalAuth public key. Non-secret.
     * @returns {Uint8Array}
     */
    get authPublicKey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.authkeypairresult_authPublicKey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
        const ret = wasm.authkeypairresult_code(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) AuthKeypairResult.prototype[Symbol.dispose] = AuthKeypairResult.prototype.free;

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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
 * WASM-bindgen class for new-account creation results.
 */
export class CreateAccountResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(CreateAccountResult.prototype);
        obj.__wbg_ptr = ptr;
        CreateAccountResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CreateAccountResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_createaccountresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.createaccountresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Opaque Rust-owned account-key handle for the newly minted L2.
     * @returns {bigint}
     */
    get handle() {
        const ret = wasm.createaccountresult_handle(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Server-storable wrapped account key. Caller persists this; it is
     * re-supplied at the next login as the input to `unlockAccountKey`.
     * @returns {Uint8Array}
     */
    get wrappedAccountKey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.createaccountresult_wrappedAccountKey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) CreateAccountResult.prototype[Symbol.dispose] = CreateAccountResult.prototype.free;

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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) CryptoDomainGoldenVectorSnapshot.prototype[Symbol.dispose] = CryptoDomainGoldenVectorSnapshot.prototype.free;

/**
 * WASM-bindgen class for decrypted album content results.
 */
export class DecryptedContentResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(DecryptedContentResult.prototype);
        obj.__wbg_ptr = ptr;
        DecryptedContentResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecryptedContentResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decryptedcontentresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.decryptedcontentresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Client-local plaintext album content on successful decryption.
     * @returns {Uint8Array}
     */
    get plaintext() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.decryptedcontentresult_plaintext(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) DecryptedContentResult.prototype[Symbol.dispose] = DecryptedContentResult.prototype.free;

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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) DecryptedShardResult.prototype[Symbol.dispose] = DecryptedShardResult.prototype.free;

/**
 * WASM-bindgen class for encrypted album content results.
 */
export class EncryptedContentResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(EncryptedContentResult.prototype);
        obj.__wbg_ptr = ptr;
        EncryptedContentResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EncryptedContentResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_encryptedcontentresult_free(ptr, 0);
    }
    /**
     * Ciphertext including the trailing 16-byte Poly1305 tag.
     * @returns {Uint8Array}
     */
    get ciphertext() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.encryptedcontentresult_ciphertext(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
        const ret = wasm.encryptedcontentresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * 24-byte XChaCha20 nonce.
     * @returns {Uint8Array}
     */
    get nonce() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.encryptedcontentresult_nonce(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) EncryptedContentResult.prototype[Symbol.dispose] = EncryptedContentResult.prototype.free;

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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
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
     * Per-epoch Ed25519 manifest signing public key, or an empty array when
     * the handle has no sign keypair attached.
     * @returns {Uint8Array}
     */
    get signPublicKey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.epochkeyhandleresult_signPublicKey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
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
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) IdentityHandleResult.prototype[Symbol.dispose] = IdentityHandleResult.prototype.free;

/**
 * WASM-bindgen class for share-link key derivation results.
 */
export class LinkKeysResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(LinkKeysResult.prototype);
        obj.__wbg_ptr = ptr;
        LinkKeysResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LinkKeysResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_linkkeysresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.linkkeysresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * 16-byte server-visible share-link lookup ID.
     * @returns {Uint8Array}
     */
    get linkId() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.linkkeysresult_linkId(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 32-byte client-side wrapping key. Callers MUST memzero after use.
     * @returns {Uint8Array}
     */
    get wrappingKey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.linkkeysresult_wrappingKey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) LinkKeysResult.prototype[Symbol.dispose] = LinkKeysResult.prototype.free;

/**
 * WASM-bindgen class for opened-bundle results.
 */
export class OpenedBundleResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(OpenedBundleResult.prototype);
        obj.__wbg_ptr = ptr;
        OpenedBundleResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        OpenedBundleResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_openedbundleresult_free(ptr, 0);
    }
    /**
     * Album identifier the bundle was issued for.
     * @returns {string}
     */
    get albumId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.openedbundleresult_albumId(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.openedbundleresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Epoch identifier inside the bundle payload.
     * @returns {number}
     */
    get epochId() {
        const ret = wasm.openedbundleresult_epochId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 32-byte epoch seed. Callers MUST memzero after deriving tier/content keys.
     * @returns {Uint8Array}
     */
    get epochSeed() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.openedbundleresult_epochSeed(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 32-byte recipient Ed25519 public key from the payload.
     * @returns {Uint8Array}
     */
    get recipientPubkey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.openedbundleresult_recipientPubkey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 32-byte per-epoch Ed25519 manifest signing public key.
     * @returns {Uint8Array}
     */
    get signPublicKey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.openedbundleresult_signPublicKey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 32-byte per-epoch Ed25519 manifest signing seed. Callers MUST memzero.
     * @returns {Uint8Array}
     */
    get signSecretSeed() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.openedbundleresult_signSecretSeed(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Bundle format version recovered from the payload.
     * @returns {number}
     */
    get version() {
        const ret = wasm.openedbundleresult_version(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) OpenedBundleResult.prototype[Symbol.dispose] = OpenedBundleResult.prototype.free;

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
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) ProgressResult.prototype[Symbol.dispose] = ProgressResult.prototype.free;

/**
 * WASM-bindgen class for sealed bundle results.
 */
export class SealedBundleResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SealedBundleResult.prototype);
        obj.__wbg_ptr = ptr;
        SealedBundleResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SealedBundleResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sealedbundleresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.sealedbundleresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Sealed-box ciphertext bytes.
     * @returns {Uint8Array}
     */
    get sealed() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.sealedbundleresult_sealed(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 32-byte sharer Ed25519 identity public key.
     * @returns {Uint8Array}
     */
    get sharerPubkey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.sealedbundleresult_sharerPubkey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 64-byte detached Ed25519 signature over `BUNDLE_SIGN_CONTEXT || sealed`.
     * @returns {Uint8Array}
     */
    get signature() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.sealedbundleresult_signature(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) SealedBundleResult.prototype[Symbol.dispose] = SealedBundleResult.prototype.free;

/**
 * WASM-bindgen class for wrapped tier key results.
 */
export class WrappedTierKeyResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WrappedTierKeyResult.prototype);
        obj.__wbg_ptr = ptr;
        WrappedTierKeyResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WrappedTierKeyResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wrappedtierkeyresult_free(ptr, 0);
    }
    /**
     * Stable error code. Zero means success.
     * @returns {number}
     */
    get code() {
        const ret = wasm.wrappedtierkeyresult_code(this.__wbg_ptr);
        return ret;
    }
    /**
     * Wrapped tier-key ciphertext including the 16-byte Poly1305 tag.
     * @returns {Uint8Array}
     */
    get encryptedKey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.wrappedtierkeyresult_encryptedKey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 24-byte XChaCha20 nonce used by the wrapping AEAD.
     * @returns {Uint8Array}
     */
    get nonce() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.wrappedtierkeyresult_nonce(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Shard tier byte the wrapped key grants access to.
     * @returns {number}
     */
    get tier() {
        const ret = wasm.wrappedtierkeyresult_tier(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WrappedTierKeyResult.prototype[Symbol.dispose] = WrappedTierKeyResult.prototype.free;

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
 * Advances an album sync coordinator through a primitive WASM proof surface.
 * @param {string} album_id
 * @param {string} phase
 * @param {string} active_cursor
 * @param {string} pending_cursor
 * @param {boolean} rerun_requested
 * @param {number} retry_count
 * @param {number} max_retry_count
 * @param {bigint} next_retry_unix_ms
 * @param {number} last_error_code
 * @param {string} last_error_stage
 * @param {bigint} updated_at_unix_ms
 * @param {string} event_kind
 * @param {string} fetched_cursor
 * @param {string} next_cursor
 * @param {number} applied_count
 * @param {bigint} retry_after_unix_ms
 * @param {number} event_error_code
 * @returns {string}
 */
export function advanceAlbumSync(album_id, phase, active_cursor, pending_cursor, rerun_requested, retry_count, max_retry_count, next_retry_unix_ms, last_error_code, last_error_stage, updated_at_unix_ms, event_kind, fetched_cursor, next_cursor, applied_count, retry_after_unix_ms, event_error_code) {
    let deferred9_0;
    let deferred9_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(album_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(phase, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(active_cursor, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(pending_cursor, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(last_error_stage, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(event_kind, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(fetched_cursor, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(next_cursor, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len7 = WASM_VECTOR_LEN;
        wasm.advanceAlbumSync(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, rerun_requested, retry_count, max_retry_count, next_retry_unix_ms, last_error_code, ptr4, len4, updated_at_unix_ms, ptr5, len5, ptr6, len6, ptr7, len7, applied_count, retry_after_unix_ms, event_error_code);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred9_0 = r0;
        deferred9_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred9_0, deferred9_1, 1);
    }
}

/**
 * Advances a client-core upload job through a primitive WASM proof surface.
 * @param {string} job_id
 * @param {string} album_id
 * @param {string} asset_id
 * @param {number} epoch_id
 * @param {string} phase
 * @param {number} active_tier
 * @param {number} active_shard_index
 * @param {number} retry_count
 * @param {number} max_retry_count
 * @param {bigint} next_retry_unix_ms
 * @param {number} last_error_code
 * @param {string} last_error_stage
 * @param {boolean} sync_confirmed
 * @param {bigint} updated_at_unix_ms
 * @param {string} event_kind
 * @param {number} event_epoch_id
 * @param {number} event_tier
 * @param {number} event_shard_index
 * @param {string} event_shard_id
 * @param {string} event_sha256
 * @param {string} event_manifest_id
 * @param {bigint} event_manifest_version
 * @param {string} observed_asset_id
 * @param {bigint} retry_after_unix_ms
 * @param {number} event_error_code
 * @returns {string}
 */
export function advanceUploadJob(job_id, album_id, asset_id, epoch_id, phase, active_tier, active_shard_index, retry_count, max_retry_count, next_retry_unix_ms, last_error_code, last_error_stage, sync_confirmed, updated_at_unix_ms, event_kind, event_epoch_id, event_tier, event_shard_index, event_shard_id, event_sha256, event_manifest_id, event_manifest_version, observed_asset_id, retry_after_unix_ms, event_error_code) {
    let deferred11_0;
    let deferred11_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(job_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(album_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(asset_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(phase, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(last_error_stage, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(event_kind, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(event_shard_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(event_sha256, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passStringToWasm0(event_manifest_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passStringToWasm0(observed_asset_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len9 = WASM_VECTOR_LEN;
        wasm.advanceUploadJob(retptr, ptr0, len0, ptr1, len1, ptr2, len2, epoch_id, ptr3, len3, active_tier, active_shard_index, retry_count, max_retry_count, next_retry_unix_ms, last_error_code, ptr4, len4, sync_confirmed, updated_at_unix_ms, ptr5, len5, event_epoch_id, event_tier, event_shard_index, ptr6, len6, ptr7, len7, ptr8, len8, event_manifest_version, ptr9, len9, retry_after_unix_ms, event_error_code);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred11_0 = r0;
        deferred11_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred11_0, deferred11_1, 1);
    }
}

/**
 * Builds the canonical LocalAuth challenge transcript through WASM.
 *
 * `timestamp_ms_present == false` omits the timestamp segment.
 * @param {string} username
 * @param {bigint} timestamp_ms
 * @param {boolean} timestamp_ms_present
 * @param {Uint8Array} challenge
 * @returns {BytesResult}
 */
export function buildAuthChallengeTranscript(username, timestamp_ms, timestamp_ms_present, challenge) {
    const ptr0 = passStringToWasm0(username, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(challenge, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.buildAuthChallengeTranscript(ptr0, len0, timestamp_ms, timestamp_ms_present, ptr1, len1);
    return BytesResult.__wrap(ret);
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
    const ptr0 = passArray8ToWasm0(album_id, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(photo_id, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(encoded_fields, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.canonicalMetadataSidecarBytes(ptr0, len0, ptr1, len1, epoch_id, ptr2, len2);
    return BytesResult.__wrap(ret);
}

/**
 * Returns the client-core state machine surface through WASM.
 * @returns {string}
 */
export function clientCoreStateMachineSnapshot() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.clientCoreStateMachineSnapshot(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
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
 * Creates a fresh account-key handle through the generated WASM binding
 * surface. Returns the opaque handle plus the wrapped account key the
 * caller must persist on the server for future logins.
 * @param {Uint8Array} password
 * @param {Uint8Array} user_salt
 * @param {Uint8Array} account_salt
 * @param {number} kdf_memory_kib
 * @param {number} kdf_iterations
 * @param {number} kdf_parallelism
 * @returns {CreateAccountResult}
 */
export function createAccount(password, user_salt, account_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism) {
    const ptr0 = passArray8ToWasm0(password, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(user_salt, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(account_salt, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.createAccount(ptr0, len0, ptr1, len1, ptr2, len2, kdf_memory_kib, kdf_iterations, kdf_parallelism);
    return CreateAccountResult.__wrap(ret);
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
 * Decrypts album content with an epoch handle through WASM.
 * @param {bigint} epoch_handle
 * @param {Uint8Array} nonce
 * @param {Uint8Array} ciphertext
 * @returns {DecryptedContentResult}
 */
export function decryptAlbumContent(epoch_handle, nonce, ciphertext) {
    const ptr0 = passArray8ToWasm0(nonce, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.decryptAlbumContent(epoch_handle, ptr0, len0, ptr1, len1);
    return DecryptedContentResult.__wrap(ret);
}

/**
 * Decrypts shard envelope bytes with an epoch-key handle through WASM.
 * @param {bigint} handle
 * @param {Uint8Array} envelope_bytes
 * @returns {DecryptedShardResult}
 */
export function decryptShardWithEpochHandle(handle, envelope_bytes) {
    const ptr0 = passArray8ToWasm0(envelope_bytes, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decryptShardWithEpochHandle(handle, ptr0, len0);
    return DecryptedShardResult.__wrap(ret);
}

/**
 * Derives the LocalAuth Ed25519 keypair from an account-key handle through WASM.
 * @param {bigint} account_handle
 * @returns {AuthKeypairResult}
 */
export function deriveAuthKeypairFromAccount(account_handle) {
    const ret = wasm.deriveAuthKeypairFromAccount(account_handle);
    return AuthKeypairResult.__wrap(ret);
}

/**
 * Derives the password-rooted LocalAuth Ed25519 keypair through WASM.
 *
 * Used by the worker's `deriveAuthKey()` pre-auth slot to mint an auth
 * keypair before the account handle is opened. Only the 32-byte public
 * key crosses the WASM boundary.
 * @param {Uint8Array} password
 * @param {Uint8Array} user_salt
 * @param {number} kdf_memory_kib
 * @param {number} kdf_iterations
 * @param {number} kdf_parallelism
 * @returns {AuthKeypairResult}
 */
export function deriveAuthKeypairFromPassword(password, user_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism) {
    const ptr0 = passArray8ToWasm0(password, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(user_salt, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.deriveAuthKeypairFromPassword(ptr0, len0, ptr1, len1, kdf_memory_kib, kdf_iterations, kdf_parallelism);
    return AuthKeypairResult.__wrap(ret);
}

/**
 * Derives the content key from an epoch handle through WASM.
 * @param {bigint} epoch_handle
 * @returns {BytesResult}
 */
export function deriveContentKeyFromEpoch(epoch_handle) {
    const ret = wasm.deriveContentKeyFromEpoch(epoch_handle);
    return BytesResult.__wrap(ret);
}

/**
 * Derives the OPFS-snapshot DB session key from the L2 account key
 * referenced by `account_handle` through WASM. Caller MUST memzero the
 * returned bytes after use.
 * @param {bigint} account_handle
 * @returns {BytesResult}
 */
export function deriveDbSessionKeyFromAccount(account_handle) {
    const ret = wasm.deriveDbSessionKeyFromAccount(account_handle);
    return BytesResult.__wrap(ret);
}

/**
 * Derives the (link_id, wrapping_key) pair from a share-link secret through WASM.
 * @param {Uint8Array} link_secret
 * @returns {LinkKeysResult}
 */
export function deriveLinkKeys(link_secret) {
    const ptr0 = passArray8ToWasm0(link_secret, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.deriveLinkKeys(ptr0, len0);
    return LinkKeysResult.__wrap(ret);
}

/**
 * Encrypts album content with an epoch handle through WASM.
 * @param {bigint} epoch_handle
 * @param {Uint8Array} plaintext
 * @returns {EncryptedContentResult}
 */
export function encryptAlbumContent(epoch_handle, plaintext) {
    const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encryptAlbumContent(epoch_handle, ptr0, len0);
    return EncryptedContentResult.__wrap(ret);
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
    const ptr0 = passArray8ToWasm0(album_id, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(photo_id, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(encoded_fields, wasm.__wbindgen_export2);
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
    const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export2);
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
 * Generates a fresh share-link secret through WASM.
 * @returns {BytesResult}
 */
export function generateLinkSecret() {
    const ret = wasm.generateLinkSecret();
    return BytesResult.__wrap(ret);
}

/**
 * Returns the LocalAuth Ed25519 public key for an account-key handle through WASM.
 * @param {bigint} account_handle
 * @returns {BytesResult}
 */
export function getAuthPublicKeyFromAccount(account_handle) {
    const ret = wasm.getAuthPublicKeyFromAccount(account_handle);
    return BytesResult.__wrap(ret);
}

/**
 * Returns the LocalAuth Ed25519 public key derived from `password` +
 * `user_salt` through WASM.
 * @param {Uint8Array} password
 * @param {Uint8Array} user_salt
 * @param {number} kdf_memory_kib
 * @param {number} kdf_iterations
 * @param {number} kdf_parallelism
 * @returns {BytesResult}
 */
export function getAuthPublicKeyFromPassword(password, user_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism) {
    const ptr0 = passArray8ToWasm0(password, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(user_salt, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.getAuthPublicKeyFromPassword(ptr0, len0, ptr1, len1, kdf_memory_kib, kdf_iterations, kdf_parallelism);
    return BytesResult.__wrap(ret);
}

/**
 * Returns a tier key for an epoch handle through WASM.
 * @param {bigint} epoch_handle
 * @param {number} tier_byte
 * @returns {BytesResult}
 */
export function getTierKeyFromEpoch(epoch_handle, tier_byte) {
    const ret = wasm.getTierKeyFromEpoch(epoch_handle, tier_byte);
    return BytesResult.__wrap(ret);
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
 * Imports an epoch handle from cleartext bundle payload bytes through WASM.
 * Both the epoch seed and the manifest signing seed are zeroized inside
 * Rust on every path.
 * @param {bigint} account_key_handle
 * @param {number} epoch_id
 * @param {Uint8Array} epoch_seed
 * @param {Uint8Array} sign_secret_seed
 * @param {Uint8Array} sign_public
 * @returns {EpochKeyHandleResult}
 */
export function importEpochKeyHandleFromBundle(account_key_handle, epoch_id, epoch_seed, sign_secret_seed, sign_public) {
    const ptr0 = passArray8ToWasm0(epoch_seed, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(sign_secret_seed, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(sign_public, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.importEpochKeyHandleFromBundle(account_key_handle, epoch_id, ptr0, len0, ptr1, len1, ptr2, len2);
    return EpochKeyHandleResult.__wrap(ret);
}

/**
 * Initializes an album sync coordinator through a primitive WASM proof surface.
 * @param {string} album_id
 * @param {string} request_id
 * @param {string} start_cursor
 * @param {bigint} now_unix_ms
 * @param {number} max_retry_count
 * @returns {string}
 */
export function initAlbumSync(album_id, request_id, start_cursor, now_unix_ms, max_retry_count) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(album_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(request_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(start_cursor, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        wasm.initAlbumSync(retptr, ptr0, len0, ptr1, len1, ptr2, len2, now_unix_ms, max_retry_count);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Initializes a client-core upload job through a primitive WASM proof surface.
 * @param {string} job_id
 * @param {string} album_id
 * @param {string} asset_id
 * @param {number} epoch_id
 * @param {bigint} now_unix_ms
 * @param {number} max_retry_count
 * @returns {string}
 */
export function initUploadJob(job_id, album_id, asset_id, epoch_id, now_unix_ms, max_retry_count) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(job_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(album_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(asset_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        wasm.initUploadJob(retptr, ptr0, len0, ptr1, len1, ptr2, len2, epoch_id, now_unix_ms, max_retry_count);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Opens an epoch-key handle through WASM.
 * @param {Uint8Array} wrapped_epoch_seed
 * @param {bigint} account_key_handle
 * @param {number} epoch_id
 * @returns {EpochKeyHandleResult}
 */
export function openEpochKeyHandle(wrapped_epoch_seed, account_key_handle, epoch_id) {
    const ptr0 = passArray8ToWasm0(wrapped_epoch_seed, wasm.__wbindgen_export2);
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
    const ptr0 = passArray8ToWasm0(wrapped_identity_seed, wasm.__wbindgen_export2);
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
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export2);
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
 * Seals and signs an epoch key bundle through WASM.
 * @param {bigint} identity_handle
 * @param {Uint8Array} recipient_pubkey
 * @param {string} album_id
 * @param {number} epoch_id
 * @param {Uint8Array} epoch_seed
 * @param {Uint8Array} sign_secret
 * @param {Uint8Array} sign_public
 * @returns {SealedBundleResult}
 */
export function sealAndSignBundle(identity_handle, recipient_pubkey, album_id, epoch_id, epoch_seed, sign_secret, sign_public) {
    const ptr0 = passArray8ToWasm0(recipient_pubkey, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(album_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(epoch_seed, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(sign_secret, wasm.__wbindgen_export2);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(sign_public, wasm.__wbindgen_export2);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.sealAndSignBundle(identity_handle, ptr0, len0, ptr1, len1, epoch_id, ptr2, len2, ptr3, len3, ptr4, len4);
    return SealedBundleResult.__wrap(ret);
}

/**
 * Atomically seals an epoch key bundle for `recipient_pubkey` using a
 * Rust-owned epoch handle through WASM. Bundle payload bytes never cross
 * the FFI boundary.
 * @param {bigint} identity_handle
 * @param {bigint} epoch_handle
 * @param {Uint8Array} recipient_pubkey
 * @param {string} album_id
 * @returns {SealedBundleResult}
 */
export function sealBundleWithEpochHandle(identity_handle, epoch_handle, recipient_pubkey, album_id) {
    const ptr0 = passArray8ToWasm0(recipient_pubkey, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(album_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.sealBundleWithEpochHandle(identity_handle, epoch_handle, ptr0, len0, ptr1, len1);
    return SealedBundleResult.__wrap(ret);
}

/**
 * Signs a LocalAuth challenge transcript with an account-key handle through WASM.
 * @param {bigint} account_handle
 * @param {Uint8Array} challenge_bytes
 * @returns {BytesResult}
 */
export function signAuthChallengeWithAccount(account_handle, challenge_bytes) {
    const ptr0 = passArray8ToWasm0(challenge_bytes, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.signAuthChallengeWithAccount(account_handle, ptr0, len0);
    return BytesResult.__wrap(ret);
}

/**
 * Signs a LocalAuth challenge transcript with the password-rooted auth
 * keypair through WASM.
 * @param {Uint8Array} password
 * @param {Uint8Array} user_salt
 * @param {number} kdf_memory_kib
 * @param {number} kdf_iterations
 * @param {number} kdf_parallelism
 * @param {Uint8Array} transcript_bytes
 * @returns {BytesResult}
 */
export function signAuthChallengeWithPassword(password, user_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism, transcript_bytes) {
    const ptr0 = passArray8ToWasm0(password, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(user_salt, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(transcript_bytes, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.signAuthChallengeWithPassword(ptr0, len0, ptr1, len1, kdf_memory_kib, kdf_iterations, kdf_parallelism, ptr2, len2);
    return BytesResult.__wrap(ret);
}

/**
 * Signs manifest transcript bytes with the per-epoch manifest signing key
 * attached to an epoch handle through WASM.
 * @param {bigint} handle
 * @param {Uint8Array} transcript_bytes
 * @returns {BytesResult}
 */
export function signManifestWithEpochHandle(handle, transcript_bytes) {
    const ptr0 = passArray8ToWasm0(transcript_bytes, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.signManifestWithEpochHandle(handle, ptr0, len0);
    return BytesResult.__wrap(ret);
}

/**
 * Signs manifest transcript bytes through WASM.
 * @param {bigint} handle
 * @param {Uint8Array} transcript_bytes
 * @returns {BytesResult}
 */
export function signManifestWithIdentity(handle, transcript_bytes) {
    const ptr0 = passArray8ToWasm0(transcript_bytes, wasm.__wbindgen_export2);
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
    const ptr0 = passArray8ToWasm0(password, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(user_salt, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(account_salt, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(wrapped_account_key, wasm.__wbindgen_export2);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.unlockAccountKey(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, kdf_memory_kib, kdf_iterations, kdf_parallelism);
    return AccountUnlockResult.__wrap(ret);
}

/**
 * Unwraps a wrapped key with a 32-byte wrapper key through WASM.
 * @param {Uint8Array} wrapped
 * @param {Uint8Array} wrapper_key
 * @returns {BytesResult}
 */
export function unwrapKey(wrapped, wrapper_key) {
    const ptr0 = passArray8ToWasm0(wrapped, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(wrapper_key, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.unwrapKey(ptr0, len0, ptr1, len1);
    return BytesResult.__wrap(ret);
}

/**
 * Unwraps a tier key from a share-link record through WASM.
 * @param {Uint8Array} nonce
 * @param {Uint8Array} encrypted_key
 * @param {number} tier_byte
 * @param {Uint8Array} wrapping_key
 * @returns {BytesResult}
 */
export function unwrapTierKeyFromLink(nonce, encrypted_key, tier_byte, wrapping_key) {
    const ptr0 = passArray8ToWasm0(nonce, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(encrypted_key, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(wrapping_key, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.unwrapTierKeyFromLink(ptr0, len0, ptr1, len1, tier_byte, ptr2, len2);
    return BytesResult.__wrap(ret);
}

/**
 * Unwraps `wrapped` with the L2 account key referenced by `account_handle`
 * through WASM.
 * @param {bigint} account_handle
 * @param {Uint8Array} wrapped
 * @returns {BytesResult}
 */
export function unwrapWithAccountHandle(account_handle, wrapped) {
    const ptr0 = passArray8ToWasm0(wrapped, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.unwrapWithAccountHandle(account_handle, ptr0, len0);
    return BytesResult.__wrap(ret);
}

/**
 * Verifies and opens a sealed epoch key bundle through WASM.
 * @param {bigint} identity_handle
 * @param {Uint8Array} sealed
 * @param {Uint8Array} signature
 * @param {Uint8Array} sharer_pubkey
 * @param {string} expected_album_id
 * @param {number} expected_min_epoch
 * @param {boolean} allow_legacy_empty
 * @returns {OpenedBundleResult}
 */
export function verifyAndOpenBundle(identity_handle, sealed, signature, sharer_pubkey, expected_album_id, expected_min_epoch, allow_legacy_empty) {
    const ptr0 = passArray8ToWasm0(sealed, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(sharer_pubkey, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(expected_album_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.verifyAndOpenBundle(identity_handle, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, expected_min_epoch, allow_legacy_empty);
    return OpenedBundleResult.__wrap(ret);
}

/**
 * Verifies manifest transcript bytes with a per-epoch manifest signing
 * public key through WASM.
 * @param {Uint8Array} transcript_bytes
 * @param {Uint8Array} signature
 * @param {Uint8Array} public_key
 * @returns {number}
 */
export function verifyManifestWithEpoch(transcript_bytes, signature, public_key) {
    const ptr0 = passArray8ToWasm0(transcript_bytes, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(public_key, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.verifyManifestWithEpoch(ptr0, len0, ptr1, len1, ptr2, len2);
    return ret;
}

/**
 * Verifies manifest transcript bytes through WASM.
 * @param {Uint8Array} transcript_bytes
 * @param {Uint8Array} signature
 * @param {Uint8Array} public_key
 * @returns {number}
 */
export function verifyManifestWithIdentity(transcript_bytes, signature, public_key) {
    const ptr0 = passArray8ToWasm0(transcript_bytes, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(public_key, wasm.__wbindgen_export2);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.verifyManifestWithIdentity(ptr0, len0, ptr1, len1, ptr2, len2);
    return ret;
}

/**
 * Wraps a key with a 32-byte wrapper key through WASM.
 * @param {Uint8Array} key_bytes
 * @param {Uint8Array} wrapper_key
 * @returns {BytesResult}
 */
export function wrapKey(key_bytes, wrapper_key) {
    const ptr0 = passArray8ToWasm0(key_bytes, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(wrapper_key, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.wrapKey(ptr0, len0, ptr1, len1);
    return BytesResult.__wrap(ret);
}

/**
 * Wraps a tier key for share-link distribution through WASM.
 * @param {bigint} epoch_handle
 * @param {number} tier_byte
 * @param {Uint8Array} wrapping_key
 * @returns {WrappedTierKeyResult}
 */
export function wrapTierKeyForLink(epoch_handle, tier_byte, wrapping_key) {
    const ptr0 = passArray8ToWasm0(wrapping_key, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wrapTierKeyForLink(epoch_handle, tier_byte, ptr0, len0);
    return WrappedTierKeyResult.__wrap(ret);
}

/**
 * Wraps `plaintext` with the L2 account key referenced by `account_handle`
 * through WASM. The L2 bytes never cross the JS boundary.
 * @param {bigint} account_handle
 * @param {Uint8Array} plaintext
 * @returns {BytesResult}
 */
export function wrapWithAccountHandle(account_handle, plaintext) {
    const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wrapWithAccountHandle(account_handle, ptr0, len0);
    return BytesResult.__wrap(ret);
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
const AuthKeypairResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_authkeypairresult_free(ptr >>> 0, 1));
const BytesResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_bytesresult_free(ptr >>> 0, 1));
const CreateAccountResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_createaccountresult_free(ptr >>> 0, 1));
const CryptoDomainGoldenVectorSnapshotFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_cryptodomaingoldenvectorsnapshot_free(ptr >>> 0, 1));
const DecryptedContentResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decryptedcontentresult_free(ptr >>> 0, 1));
const DecryptedShardResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decryptedshardresult_free(ptr >>> 0, 1));
const EncryptedContentResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_encryptedcontentresult_free(ptr >>> 0, 1));
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
const LinkKeysResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_linkkeysresult_free(ptr >>> 0, 1));
const OpenedBundleResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_openedbundleresult_free(ptr >>> 0, 1));
const ProgressEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_progressevent_free(ptr >>> 0, 1));
const ProgressResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_progressresult_free(ptr >>> 0, 1));
const SealedBundleResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sealedbundleresult_free(ptr >>> 0, 1));
const WrappedTierKeyResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wrappedtierkeyresult_free(ptr >>> 0, 1));

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

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
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

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
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
