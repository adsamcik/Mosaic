import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => {
  const init = vi.fn().mockResolvedValue(undefined);
  return {
    default: init,
    sidecarPakeInitiatorStartV1: vi.fn(),
    sidecarPakeInitiatorFinishV1: vi.fn(),
    sidecarPakeInitiatorCloseV1: vi.fn(),
    sidecarPakeResponderV1: vi.fn(),
    sidecarPakeResponderFinishV1: vi.fn(),
    sidecarPakeResponderCloseV1: vi.fn(),
    sidecarTunnelOpenV1: vi.fn(),
    sidecarTunnelSealV1: vi.fn(),
    sidecarTunnelOpenMessageV1: vi.fn(),
    sidecarTunnelCloseV1: vi.fn(),
  };
});

import * as wasmStub from '../../generated/mosaic-wasm/mosaic_wasm.js';
import {
  rustOpenSidecarPakeInitiator,
  rustOpenSidecarPakeResponder,
  rustOpenSidecarTunnel,
} from '../rust-crypto-core';
import { WorkerCryptoError, WorkerCryptoErrorCode } from '../types';

interface FakeResult {
  code: number;
  free: ReturnType<typeof vi.fn>;
}

function startOk(handleId = 11, msg1 = new Uint8Array([1, 2, 3])): FakeResult & {
  handleId: number;
  msg1: Uint8Array;
} {
  return { code: 0, handleId, msg1, free: vi.fn() };
}
function responderOk(
  handleId = 22,
  msg2 = new Uint8Array([4, 5, 6]),
  responderConfirm = new Uint8Array([7, 8, 9]),
): FakeResult & { responderHandleId: number; msg2: Uint8Array; responderConfirm: Uint8Array } {
  return { code: 0, responderHandleId: handleId, msg2, responderConfirm, free: vi.fn() };
}
function initFinishOk(
  matId = 33,
  initiatorConfirm = new Uint8Array([10, 11, 12]),
): FakeResult & { materialHandleId: number; initiatorConfirm: Uint8Array } {
  return { code: 0, materialHandleId: matId, initiatorConfirm, free: vi.fn() };
}
function respFinishOk(matId = 44): FakeResult & { materialHandleId: number } {
  return { code: 0, materialHandleId: matId, free: vi.fn() };
}
function tunnelOpenOk(sendId = 55, recvId = 66): FakeResult & {
  sendHandleId: number;
  recvHandleId: number;
} {
  return { code: 0, sendHandleId: sendId, recvHandleId: recvId, free: vi.fn() };
}
function sealOk(sealed = new Uint8Array([99, 100])): FakeResult & { sealed: Uint8Array } {
  return { code: 0, sealed, free: vi.fn() };
}
function openMsgOk(plaintext = new Uint8Array([200, 201])): FakeResult & {
  plaintext: Uint8Array;
} {
  return { code: 0, plaintext, free: vi.fn() };
}
function errResult<T extends Record<string, unknown>>(code: number, extra: T): FakeResult & T {
  return { code, free: vi.fn(), ...extra };
}

const stub = wasmStub as unknown as {
  sidecarPakeInitiatorStartV1: ReturnType<typeof vi.fn>;
  sidecarPakeInitiatorFinishV1: ReturnType<typeof vi.fn>;
  sidecarPakeInitiatorCloseV1: ReturnType<typeof vi.fn>;
  sidecarPakeResponderV1: ReturnType<typeof vi.fn>;
  sidecarPakeResponderFinishV1: ReturnType<typeof vi.fn>;
  sidecarPakeResponderCloseV1: ReturnType<typeof vi.fn>;
  sidecarTunnelOpenV1: ReturnType<typeof vi.fn>;
  sidecarTunnelSealV1: ReturnType<typeof vi.fn>;
  sidecarTunnelOpenMessageV1: ReturnType<typeof vi.fn>;
  sidecarTunnelCloseV1: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  stub.sidecarPakeInitiatorCloseV1.mockReturnValue(0);
  stub.sidecarPakeResponderCloseV1.mockReturnValue(0);
  stub.sidecarTunnelCloseV1.mockReturnValue(0);
});

const CODE = new Uint8Array([0x34, 0x38, 0x32, 0x39, 0x31, 0x35]); // "482915"

describe('rustOpenSidecarPakeInitiator', () => {
  it('start() returns msg1 bytes from the Rust handle', async () => {
    stub.sidecarPakeInitiatorStartV1.mockReturnValue(startOk(11, new Uint8Array([1, 2, 3])));
    const initiator = await rustOpenSidecarPakeInitiator();
    const { msg1 } = await initiator.start(CODE);
    expect(Array.from(msg1)).toEqual([1, 2, 3]);
    expect(stub.sidecarPakeInitiatorStartV1).toHaveBeenCalledWith(CODE);
  });

  it('start() rejects a non-6-byte pairing code without touching WASM', async () => {
    const initiator = await rustOpenSidecarPakeInitiator();
    await expect(initiator.start(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(WorkerCryptoError);
    expect(stub.sidecarPakeInitiatorStartV1).not.toHaveBeenCalled();
  });

  it('finish() surfaces material handle + initiatorConfirm', async () => {
    stub.sidecarPakeInitiatorStartV1.mockReturnValue(startOk());
    stub.sidecarPakeInitiatorFinishV1.mockReturnValue(
      initFinishOk(33, new Uint8Array([10, 11, 12])),
    );
    const initiator = await rustOpenSidecarPakeInitiator();
    await initiator.start(CODE);
    const { keyMaterialHandle, initiatorConfirm } = await initiator.finish(
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    );
    expect(keyMaterialHandle).toBe(33);
    expect(Array.from(initiatorConfirm)).toEqual([10, 11, 12]);
  });

  it('finish() with non-zero code throws and clears the handle', async () => {
    stub.sidecarPakeInitiatorStartV1.mockReturnValue(startOk());
    stub.sidecarPakeInitiatorFinishV1.mockReturnValue(
      errResult(WorkerCryptoErrorCode.AuthenticationFailed, {
        materialHandleId: 0,
        initiatorConfirm: new Uint8Array(),
      }),
    );
    const initiator = await rustOpenSidecarPakeInitiator();
    await initiator.start(CODE);
    await expect(
      initiator.finish(new Uint8Array([0]), new Uint8Array([0])),
    ).rejects.toBeInstanceOf(WorkerCryptoError);
    // close() after failure is idempotent and does not call WASM (Rust already removed the handle).
    await initiator.close();
    expect(stub.sidecarPakeInitiatorCloseV1).not.toHaveBeenCalled();
  });

  it('close() is idempotent', async () => {
    stub.sidecarPakeInitiatorStartV1.mockReturnValue(startOk());
    const initiator = await rustOpenSidecarPakeInitiator();
    await initiator.start(CODE);
    await initiator.close();
    await initiator.close();
    expect(stub.sidecarPakeInitiatorCloseV1).toHaveBeenCalledTimes(1);
  });
});

describe('rustOpenSidecarPakeResponder', () => {
  it('step() returns msg2 + responderConfirm', async () => {
    stub.sidecarPakeResponderV1.mockReturnValue(
      responderOk(22, new Uint8Array([4, 5, 6]), new Uint8Array([7, 8, 9])),
    );
    const responder = await rustOpenSidecarPakeResponder();
    const { msg2, responderConfirm } = await responder.step(CODE, new Uint8Array([1, 2, 3]));
    expect(Array.from(msg2)).toEqual([4, 5, 6]);
    expect(Array.from(responderConfirm)).toEqual([7, 8, 9]);
  });

  it('finish() surfaces the material handle', async () => {
    stub.sidecarPakeResponderV1.mockReturnValue(responderOk());
    stub.sidecarPakeResponderFinishV1.mockReturnValue(respFinishOk(44));
    const responder = await rustOpenSidecarPakeResponder();
    await responder.step(CODE, new Uint8Array([1, 2, 3]));
    const { keyMaterialHandle } = await responder.finish(new Uint8Array([10, 11, 12]));
    expect(keyMaterialHandle).toBe(44);
  });

  it('finish() before step() throws StaleHandle', async () => {
    const responder = await rustOpenSidecarPakeResponder();
    await expect(responder.finish(new Uint8Array([0]))).rejects.toBeInstanceOf(WorkerCryptoError);
  });
});

describe('rustOpenSidecarTunnel', () => {
  it('seal()/open() roundtrip plaintext via the WASM handles', async () => {
    stub.sidecarTunnelOpenV1.mockReturnValue(tunnelOpenOk(55, 66));
    stub.sidecarTunnelSealV1.mockReturnValue(sealOk(new Uint8Array([99, 100, 101])));
    stub.sidecarTunnelOpenMessageV1.mockReturnValue(
      openMsgOk(new Uint8Array([200, 201, 202])),
    );

    const tunnel = await rustOpenSidecarTunnel(33);
    const sealed = await tunnel.send.seal(new Uint8Array([1, 2, 3]));
    expect(Array.from(sealed)).toEqual([99, 100, 101]);
    const opened = await tunnel.recv.open(new Uint8Array([99, 100, 101]));
    expect(Array.from(opened)).toEqual([200, 201, 202]);

    expect(stub.sidecarTunnelSealV1).toHaveBeenCalledWith(55, expect.any(Uint8Array));
    expect(stub.sidecarTunnelOpenMessageV1).toHaveBeenCalledWith(66, expect.any(Uint8Array));
  });

  it('seal() after close() rejects with StaleHandle and never calls WASM', async () => {
    stub.sidecarTunnelOpenV1.mockReturnValue(tunnelOpenOk());
    const tunnel = await rustOpenSidecarTunnel(1);
    await tunnel.close();
    await expect(tunnel.send.seal(new Uint8Array([1]))).rejects.toBeInstanceOf(WorkerCryptoError);
    expect(stub.sidecarTunnelSealV1).not.toHaveBeenCalled();
  });

  it('open() after close() rejects with StaleHandle', async () => {
    stub.sidecarTunnelOpenV1.mockReturnValue(tunnelOpenOk());
    const tunnel = await rustOpenSidecarTunnel(1);
    await tunnel.close();
    await expect(tunnel.recv.open(new Uint8Array([1]))).rejects.toBeInstanceOf(WorkerCryptoError);
  });

  it('close() is idempotent and only calls Rust once', async () => {
    stub.sidecarTunnelOpenV1.mockReturnValue(tunnelOpenOk(7, 8));
    const tunnel = await rustOpenSidecarTunnel(1);
    await tunnel.close();
    await tunnel.close();
    expect(stub.sidecarTunnelCloseV1).toHaveBeenCalledTimes(1);
    expect(stub.sidecarTunnelCloseV1).toHaveBeenCalledWith(7, 8);
  });

  it('seal() returns a defensive copy detached from wasm-bindgen memory', async () => {
    stub.sidecarTunnelOpenV1.mockReturnValue(tunnelOpenOk());
    const wasmBuf = new Uint8Array([111, 112, 113]);
    stub.sidecarTunnelSealV1.mockReturnValue(sealOk(wasmBuf));
    const tunnel = await rustOpenSidecarTunnel(1);
    const sealed = await tunnel.send.seal(new Uint8Array([1]));
    // Mutating the original WASM-side buffer must not corrupt the returned slice.
    wasmBuf.fill(0);
    expect(Array.from(sealed)).toEqual([111, 112, 113]);
  });
});
