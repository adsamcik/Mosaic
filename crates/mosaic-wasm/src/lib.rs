//! WASM facade boundary crate for the Mosaic web worker integration.

#![forbid(unsafe_code)]

use wasm_bindgen::prelude::wasm_bindgen;

/// Rust-side WASM facade result for header parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderResult {
    pub code: u16,
    pub epoch_id: u32,
    pub shard_index: u32,
    pub tier: u8,
    pub nonce: Vec<u8>,
}

/// Rust-side WASM facade progress event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressEvent {
    pub completed_steps: u32,
    pub total_steps: u32,
}

/// Rust-side WASM facade progress result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressResult {
    pub code: u16,
    pub events: Vec<ProgressEvent>,
}

/// WASM-bindgen class for header parse results.
#[wasm_bindgen(js_name = HeaderResult)]
pub struct JsHeaderResult {
    code: u16,
    epoch_id: u32,
    shard_index: u32,
    tier: u8,
    nonce: Vec<u8>,
}

#[wasm_bindgen(js_class = HeaderResult)]
impl JsHeaderResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Parsed epoch ID when parsing succeeds.
    #[wasm_bindgen(getter, js_name = epochId)]
    #[must_use]
    pub fn epoch_id(&self) -> u32 {
        self.epoch_id
    }

    /// Parsed shard index when parsing succeeds.
    #[wasm_bindgen(getter, js_name = shardIndex)]
    #[must_use]
    pub fn shard_index(&self) -> u32 {
        self.shard_index
    }

    /// Parsed tier byte when parsing succeeds.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn tier(&self) -> u8 {
        self.tier
    }

    /// Parsed nonce when parsing succeeds.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }
}

/// WASM-bindgen class for progress events.
#[wasm_bindgen(js_name = ProgressEvent)]
pub struct JsProgressEvent {
    completed_steps: u32,
    total_steps: u32,
}

#[wasm_bindgen(js_class = ProgressEvent)]
impl JsProgressEvent {
    /// Completed operation steps.
    #[wasm_bindgen(getter, js_name = completedSteps)]
    #[must_use]
    pub fn completed_steps(&self) -> u32 {
        self.completed_steps
    }

    /// Total operation steps.
    #[wasm_bindgen(getter, js_name = totalSteps)]
    #[must_use]
    pub fn total_steps(&self) -> u32 {
        self.total_steps
    }
}

/// WASM-bindgen class for progress results.
#[wasm_bindgen(js_name = ProgressResult)]
pub struct JsProgressResult {
    code: u16,
    event_pairs: Vec<u32>,
}

#[wasm_bindgen(js_class = ProgressResult)]
impl JsProgressResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Flattened completed/total pairs for low-friction JS marshalling.
    #[wasm_bindgen(getter, js_name = eventPairs)]
    #[must_use]
    pub fn event_pairs(&self) -> Vec<u32> {
        self.event_pairs.clone()
    }
}

/// Returns the crate name for smoke tests and generated wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-wasm"
}

/// Returns the domain protocol version this WASM facade is compiled against.
#[must_use]
pub const fn protocol_version() -> &'static str {
    mosaic_client::protocol_version()
}

/// Returns the stable WASM API snapshot for this FFI spike.
#[must_use]
pub const fn wasm_api_snapshot() -> &'static str {
    "mosaic-wasm ffi-spike:v1 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult"
}

/// Parses a shard envelope header for Rust-side wrapper tests.
#[must_use]
pub fn parse_envelope_header(bytes: Vec<u8>) -> HeaderResult {
    header_result_from_client(mosaic_client::parse_shard_header_for_ffi(&bytes))
}

/// Runs the progress probe for Rust-side wrapper tests.
#[must_use]
pub fn wasm_progress_probe(total_steps: u32, cancel_after: Option<u32>) -> ProgressResult {
    progress_result_from_client(mosaic_client::run_progress_probe(total_steps, cancel_after))
}

/// Parses a shard envelope header through the generated WASM binding surface.
#[wasm_bindgen(js_name = parseEnvelopeHeader)]
#[must_use]
pub fn parse_envelope_header_js(bytes: Vec<u8>) -> JsHeaderResult {
    let result = parse_envelope_header(bytes);
    JsHeaderResult {
        code: result.code,
        epoch_id: result.epoch_id,
        shard_index: result.shard_index,
        tier: result.tier,
        nonce: result.nonce,
    }
}

/// Runs the progress probe through the generated WASM binding surface.
#[wasm_bindgen(js_name = progressProbe)]
#[must_use]
pub fn wasm_progress_probe_js(total_steps: u32, cancel_after: i64) -> JsProgressResult {
    let cancel_after = if cancel_after < 0 {
        None
    } else {
        u32::try_from(cancel_after).ok()
    };
    let result = mosaic_client::run_progress_probe(total_steps, cancel_after);
    let mut event_pairs = Vec::with_capacity(result.events.len() * 2);
    for event in result.events {
        event_pairs.push(event.completed_steps);
        event_pairs.push(event.total_steps);
    }

    JsProgressResult {
        code: result.code.as_u16(),
        event_pairs,
    }
}

fn header_result_from_client(result: mosaic_client::HeaderResult) -> HeaderResult {
    HeaderResult {
        code: result.code.as_u16(),
        epoch_id: result.epoch_id,
        shard_index: result.shard_index,
        tier: result.tier,
        nonce: result.nonce,
    }
}

fn progress_result_from_client(result: mosaic_client::ProgressResult) -> ProgressResult {
    ProgressResult {
        code: result.code.as_u16(),
        events: result
            .events
            .into_iter()
            .map(|event| ProgressEvent {
                completed_steps: event.completed_steps,
                total_steps: event.total_steps,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_client_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }
}
