package org.mosaic.android.main.reducer

import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreUploadShardRef
import org.mosaic.android.main.db.RustSnapshotVersions

object UploadJobSnapshotCodec {
  private val phaseCodes = mapOf(
    0 to "Queued",
    1 to "AwaitingPreparedMedia",
    2 to "AwaitingEpochHandle",
    3 to "EncryptingShard",
    4 to "CreatingShardUpload",
    5 to "UploadingShard",
    6 to "CreatingManifest",
    7 to "ManifestCommitUnknown",
    8 to "AwaitingSyncConfirmation",
    9 to "RetryWaiting",
    10 to "Confirmed",
    11 to "Cancelled",
    12 to "Failed",
  )
  private val codeByPhase = phaseCodes.entries.associate { it.value to it.key }

  fun encode(snapshot: RustClientCoreUploadJobFfiSnapshot): ByteArray {
    val writer = CborWriter()
    writer.writeMapHeader(14)
    writer.writeUInt(0); writer.writeUInt(snapshot.schemaVersion.toLong())
    writer.writeUInt(1); writer.writeBytes(uuidToBytes(snapshot.jobId))
    writer.writeUInt(2); writer.writeBytes(uuidToBytes(snapshot.albumId))
    writer.writeUInt(3); writer.writeUInt((codeByPhase[snapshot.phase] ?: codeByPhase.getValue("Failed")).toLong())
    writer.writeUInt(4); writer.writeUInt(snapshot.retryCount.toLong())
    writer.writeUInt(5); writer.writeUInt(snapshot.maxRetryCount.toLong())
    writer.writeUInt(6); if (snapshot.hasNextRetryNotBeforeMs) writer.writeInt(snapshot.nextRetryNotBeforeMs) else writer.writeNull()
    writer.writeUInt(7); writer.writeBytes(uuidToBytes(snapshot.idempotencyKey))
    writer.writeUInt(8); writer.writeArrayHeader(snapshot.tieredShards.size)
    snapshot.tieredShards.forEach { writer.writeShard(it) }
    writer.writeUInt(9); if (snapshot.shardSetHash.isEmpty()) writer.writeNull() else writer.writeBytes(snapshot.shardSetHash)
    writer.writeUInt(10); writer.writeUInt(snapshot.snapshotRevision)
    writer.writeUInt(11); writer.writeOptionalUuid(snapshot.lastAcknowledgedEffectId)
    writer.writeUInt(12); writer.writeOptionalUuid(snapshot.lastAppliedEventId)
    writer.writeUInt(13); if (snapshot.failureCode == 0) writer.writeNull() else writer.writeUInt(snapshot.failureCode.toLong())
    return writer.toByteArray()
  }

  fun decode(bytes: ByteArray): RustClientCoreUploadJobFfiSnapshot {
    val reader = CborReader(bytes)
    val values = reader.readMap()
    val schemaVersion = values.uint(0)?.toInt() ?: RustSnapshotVersions.CURRENT
    val jobId = values.uuid(1)
    val albumId = values.uuid(2)
    val phase = values.phase(3)
    val retryCount = values.uint(4)?.toInt() ?: 0
    val maxRetryCount = values.uint(5)?.toInt() ?: 0
    val nextRetry = values.int(6)
    val idempotencyKey = values.uuid(7)
    val tieredShards = values.shards(8)
    val shardSetHash = values.bytes(9) ?: ByteArray(0)
    val snapshotRevision = values.uint(10) ?: 0
    val lastAck = values.uuidOrBlank(11)
    val lastApplied = values.uuidOrBlank(12)
    val failureCode = values.uint(13)?.toInt() ?: 0
    return RustClientCoreUploadJobFfiSnapshot(
      schemaVersion = schemaVersion,
      jobId = jobId,
      albumId = albumId,
      phase = phase,
      retryCount = retryCount,
      maxRetryCount = maxRetryCount,
      nextRetryNotBeforeMs = nextRetry ?: 0,
      hasNextRetryNotBeforeMs = nextRetry != null,
      idempotencyKey = idempotencyKey,
      tieredShards = tieredShards,
      shardSetHash = shardSetHash,
      snapshotRevision = snapshotRevision,
      lastEffectId = "",
      lastAcknowledgedEffectId = lastAck,
      lastAppliedEventId = lastApplied,
      failureCode = failureCode,
    )
  }

  private fun CborWriter.writeShard(shard: RustClientCoreUploadShardRef) {
    writeMapHeader(7)
    writeUInt(0); writeUInt(shard.tier.toLong())
    writeUInt(1); writeUInt(shard.shardIndex.toLong())
    writeUInt(2); writeBytes(uuidToBytes(shard.shardId))
    writeUInt(3); writeBytes(shard.sha256)
    writeUInt(4); writeUInt(shard.contentLength)
    writeUInt(5); writeUInt(shard.envelopeVersion.toLong())
    writeUInt(6); writeBoolean(shard.uploaded)
  }

  private fun Map<Long, CborValue>.uint(key: Long): Long? = (this[key] as? CborValue.UInt)?.value
  private fun Map<Long, CborValue>.int(key: Long): Long? = when (val value = this[key]) {
    is CborValue.UInt -> value.value
    is CborValue.NInt -> value.value
    else -> null
  }
  private fun Map<Long, CborValue>.bytes(key: Long): ByteArray? = (this[key] as? CborValue.Bytes)?.value
  private fun Map<Long, CborValue>.uuid(key: Long): String = uuidFromBytes(requireNotNull(bytes(key)) { "missing uuid key $key" })
  private fun Map<Long, CborValue>.uuidOrBlank(key: Long): String = bytes(key)?.let(::uuidFromBytes) ?: ""
  private fun Map<Long, CborValue>.phase(key: Long): String = when (val value = this[key]) {
    is CborValue.UInt -> phaseCodes[value.value.toInt()] ?: "Failed"
    is CborValue.Text -> value.value
    else -> "Failed"
  }
  private fun Map<Long, CborValue>.shards(key: Long): List<RustClientCoreUploadShardRef> =
    ((this[key] as? CborValue.Array)?.values ?: emptyList()).map { shardValue ->
      val shard = (shardValue as CborValue.MapValue).values
      RustClientCoreUploadShardRef(
        tier = shard.uint(0)?.toInt() ?: 0,
        shardIndex = shard.uint(1)?.toInt() ?: 0,
        shardId = shard.uuid(2),
        sha256 = shard.bytes(3) ?: ByteArray(0),
        contentLength = shard.uint(4) ?: 0,
        envelopeVersion = shard.uint(5)?.toInt() ?: 0,
        uploaded = (shard[6] as? CborValue.Bool)?.value ?: false,
      )
    }
}

private sealed interface CborValue {
  data class UInt(val value: Long) : CborValue
  data class NInt(val value: Long) : CborValue
  data class Bytes(val value: ByteArray) : CborValue
  data class Text(val value: String) : CborValue
  data class Array(val values: List<CborValue>) : CborValue
  data class MapValue(val values: Map<Long, CborValue>) : CborValue
  data class Bool(val value: Boolean) : CborValue
  data object Null : CborValue
}

private class CborWriter {
  private val out = ArrayList<Byte>()

  fun writeMapHeader(size: Int) = writeTypeAndValue(5, size.toLong())
  fun writeArrayHeader(size: Int) = writeTypeAndValue(4, size.toLong())
  fun writeUInt(value: Long) = writeTypeAndValue(0, value)
  fun writeInt(value: Long) {
    require(value != Long.MIN_VALUE) { "CBOR signed integer magnitude exceeds Int64 range" }
    if (value >= 0) writeUInt(value) else writeTypeAndValue(1, -1 - value)
  }
  fun writeBytes(bytes: ByteArray) {
    writeTypeAndValue(2, bytes.size.toLong())
    bytes.forEach { out += it }
  }
  fun writeBoolean(value: Boolean) { out += if (value) 0xf5.toByte() else 0xf4.toByte() }
  fun writeNull() { out += 0xf6.toByte() }
  fun writeOptionalUuid(value: String) {
    if (value.isBlank()) writeNull() else writeBytes(uuidToBytes(value))
  }
  fun toByteArray(): ByteArray = out.toByteArray()

  private fun writeTypeAndValue(type: Int, value: Long) {
    require(value >= 0) { "CBOR value must be non-negative" }
    when {
      value < 24 -> out += ((type shl 5) or value.toInt()).toByte()
      value <= 0xff -> { out += ((type shl 5) or 24).toByte(); out += value.toByte() }
      value <= 0xffff -> { out += ((type shl 5) or 25).toByte(); writeBigEndian(value, 2) }
      value <= 0xffffffffL -> { out += ((type shl 5) or 26).toByte(); writeBigEndian(value, 4) }
      else -> { out += ((type shl 5) or 27).toByte(); writeBigEndian(value, 8) }
    }
  }

  private fun writeBigEndian(value: Long, bytes: Int) {
    for (shift in (bytes - 1) * 8 downTo 0 step 8) out += ((value shr shift) and 0xff).toByte()
  }
}

private class CborReader(private val bytes: ByteArray) {
  private var offset = 0

  fun readMap(): Map<Long, CborValue> = (readValue() as CborValue.MapValue).values

  private fun readValue(): CborValue {
    val initial = readByte()
    val major = (initial.toInt() and 0xff) ushr 5
    val additional = initial.toInt() and 0x1f
    return when (major) {
      0 -> CborValue.UInt(readArgument(additional))
      1 -> CborValue.NInt(-1 - readArgument(additional))
      2 -> CborValue.Bytes(readBytes(readArgument(additional).toInt()))
      3 -> CborValue.Text(readBytes(readArgument(additional).toInt()).toString(Charsets.UTF_8))
      4 -> CborValue.Array(List(readArgument(additional).toInt()) { readValue() })
      5 -> {
        val count = readArgument(additional).toInt()
        val map = linkedMapOf<Long, CborValue>()
        repeat(count) {
          val key = (readValue() as CborValue.UInt).value
          map[key] = readValue()
        }
        CborValue.MapValue(map)
      }
      7 -> when (additional) {
        20 -> CborValue.Bool(false)
        21 -> CborValue.Bool(true)
        22 -> CborValue.Null
        else -> error("unsupported CBOR simple value $additional")
      }
      else -> error("unsupported CBOR major type $major")
    }
  }

  private fun readArgument(additional: Int): Long = when (additional) {
    in 0..23 -> additional.toLong()
    24 -> readByte().toLong() and 0xff
    25 -> readBigEndian(2)
    26 -> readBigEndian(4)
    27 -> readBigEndian(8)
    else -> error("unsupported CBOR argument $additional")
  }

  private fun readBigEndian(count: Int): Long {
    var result = 0L
    repeat(count) { result = (result shl 8) or (readByte().toLong() and 0xff) }
    return result
  }

  private fun readBytes(count: Int): ByteArray {
    require(offset + count <= bytes.size) { "CBOR payload truncated" }
    return bytes.copyOfRange(offset, offset + count).also { offset += count }
  }

  private fun readByte(): Byte {
    require(offset < bytes.size) { "CBOR payload truncated" }
    return bytes[offset++]
  }
}

private fun uuidToBytes(uuid: String): ByteArray {
  val hex = uuid.replace("-", "")
  require(hex.length == 32) { "UUID must have 32 hex digits" }
  return ByteArray(16) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
}

private fun uuidFromBytes(bytes: ByteArray): String {
  require(bytes.size == 16) { "UUID bytes must be 16 bytes" }
  val hex = bytes.joinToString("") { "%02x".format(it) }
  return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
}
