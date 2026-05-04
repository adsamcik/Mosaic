#![allow(dead_code)]

use ciborium::value::{Integer, Value};

pub const JOB_ID: [u8; 16] = [
    0x01, 0x8f, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
];
pub const ALBUM_ID: [u8; 16] = [
    0x01, 0x8f, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
];
pub const SHARD_ID: [u8; 16] = [
    0x01, 0x8f, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
];
pub const EXPECTED_HASH: [u8; 32] = [0x44; 32];

pub fn encode(value: &Value) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    ciborium::ser::into_writer(value, &mut out).map_err(|error| error.to_string())?;
    Ok(out)
}

pub fn kv(key: u32, value: Value) -> (Value, Value) {
    (Value::Integer(Integer::from(key)), value)
}

pub fn uint(value: u64) -> Value {
    Value::Integer(Integer::from(value))
}

pub fn state_cbor(code: u8) -> Result<Vec<u8>, String> {
    encode(&Value::Map(vec![kv(0, uint(u64::from(code)))]))
}

pub fn start_event_cbor() -> Result<Vec<u8>, String> {
    encode(&Value::Map(vec![
        kv(0, uint(0)),
        kv(1, Value::Bytes(JOB_ID.to_vec())),
        kv(2, Value::Bytes(ALBUM_ID.to_vec())),
    ]))
}

pub fn plan_ready_event_cbor() -> Result<Vec<u8>, String> {
    encode(&Value::Map(vec![kv(0, uint(1))]))
}

pub fn plan_input_cbor(tier: u8) -> Result<Vec<u8>, String> {
    encode(&Value::Map(vec![kv(
        0,
        Value::Array(vec![Value::Map(vec![
            kv(0, Value::Text("photo-1".to_owned())),
            kv(1, Value::Text("IMG:001.jpg".to_owned())),
            kv(
                2,
                Value::Array(vec![Value::Map(vec![
                    kv(0, Value::Bytes(SHARD_ID.to_vec())),
                    kv(1, uint(7)),
                    kv(2, uint(u64::from(tier))),
                    kv(3, Value::Bytes(EXPECTED_HASH.to_vec())),
                    kv(4, uint(1234)),
                ])]),
            ),
        ])]),
    )]))
}

pub fn init_snapshot_input_cbor(plan_cbor: Vec<u8>) -> Result<Vec<u8>, String> {
    encode(&Value::Map(vec![
        kv(0, Value::Bytes(JOB_ID.to_vec())),
        kv(1, Value::Bytes(ALBUM_ID.to_vec())),
        kv(2, Value::Bytes(plan_cbor)),
        kv(3, uint(1_700_000_000_000)),
    ]))
}
