/**
 * Sidecar ICE server configuration.
 *
 * Both the initiator (`SidecarPairingModal`) and the responder
 * (`SidecarReceivePage`) need an `iceServers` list for their
 * `RTCPeerConnection`. Historically these were hard-coded to Google's
 * public STUN server, which silently leaked every pairing user's
 * public IP and the (offerer, answerer) endpoint pair to a third party.
 * That contradicts Mosaic's zero-knowledge posture — see the audit
 * "privacy-hygiene C-2" and "sidecar-audit M-3" findings.
 *
 * The new policy is **opt-in only**:
 *
 *   - Default: empty `iceServers` list. WebRTC will still gather host
 *     candidates, which is sufficient for same-LAN pairing (the most
 *     common sidecar use case) and never reveals anything to a third
 *     party.
 *   - Operators that need cross-network pairing can set
 *     `VITE_SIDECAR_STUN_URL` (typically pointing at a self-hosted
 *     `coturn` instance) and/or `VITE_SIDECAR_TURN_URL` with optional
 *     credentials. The user-facing UI does not advertise STUN/TURN
 *     status; the decision is purely operational.
 *
 * The previous Google STUN default is intentionally NOT preserved. We
 * accept the cross-network UX regression in exchange for honoring the
 * ZK promise. If you need it for a deployment, set the env var.
 */

/**
 * Read `iceServers` from build-time env config. Returns an empty array
 * when neither STUN nor TURN is configured, so {@link RTCPeerConnection}
 * gathers host-only candidates and contacts no third party.
 */
export function buildSidecarIceServers(): readonly RTCIceServer[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined) ?? {};

  const servers: RTCIceServer[] = [];

  const stunUrl =
    typeof env['VITE_SIDECAR_STUN_URL'] === 'string'
      ? String(env['VITE_SIDECAR_STUN_URL']).trim()
      : '';
  if (stunUrl.length > 0) {
    servers.push({ urls: stunUrl });
  }

  const turnUrl =
    typeof env['VITE_SIDECAR_TURN_URL'] === 'string'
      ? String(env['VITE_SIDECAR_TURN_URL']).trim()
      : '';
  if (turnUrl.length > 0) {
    const turnUser =
      typeof env['VITE_SIDECAR_TURN_USERNAME'] === 'string'
        ? String(env['VITE_SIDECAR_TURN_USERNAME'])
        : '';
    const turnCred =
      typeof env['VITE_SIDECAR_TURN_CREDENTIAL'] === 'string'
        ? String(env['VITE_SIDECAR_TURN_CREDENTIAL'])
        : '';
    const turnServer: RTCIceServer = { urls: turnUrl };
    if (turnUser.length > 0) {
      turnServer.username = turnUser;
    }
    if (turnCred.length > 0) {
      turnServer.credential = turnCred;
    }
    servers.push(turnServer);
  }

  return servers;
}

/**
 * Read the optional signaling base-URL override (e.g. for self-hosted
 * deployments that proxy the WebSocket relay onto a different host).
 * Returns `undefined` for the default ("same origin as the page").
 */
export function buildSidecarSignalingBaseUrl(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined) ?? {};
  const override =
    typeof env['VITE_SIDECAR_SIGNAL_URL'] === 'string'
      ? String(env['VITE_SIDECAR_SIGNAL_URL']).trim()
      : '';
  return override.length > 0 ? override : undefined;
}
