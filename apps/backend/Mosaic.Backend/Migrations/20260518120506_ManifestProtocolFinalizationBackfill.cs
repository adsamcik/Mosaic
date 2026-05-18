using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <summary>
    /// Backfills semantically-wrong defaults introduced by
    /// <see cref="ManifestProtocolFinalization"/> on the <c>manifest_shards</c>
    /// table.
    ///
    /// The original migration added four columns with placeholder defaults to
    /// satisfy NOT NULL constraints on pre-existing rows:
    /// <list type="bullet">
    ///   <item><c>sha256 = ''</c></item>
    ///   <item><c>content_length = 0</c></item>
    ///   <item><c>shard_index = 0</c></item>
    ///   <item><c>envelope_version = 3</c></item>
    /// </list>
    /// For rows that pre-date that migration, these values are not "real
    /// zeroes" — they are "unknown / legacy" sentinels. This migration
    /// reconstructs the real values from the related <c>shards</c> row where
    /// the shard still exists on disk and has authoritative metadata:
    /// <list type="bullet">
    ///   <item><c>shards.sha256</c> — server-side SHA-256 of the encrypted blob</item>
    ///   <item><c>shards.size_bytes</c> — encrypted blob length</item>
    /// </list>
    /// Only rows that still carry the sentinel defaults (empty sha256 AND
    /// zero content_length) are touched. Rows already populated by the v1
    /// upload pipeline are left untouched. Orphan rows whose related shard is
    /// missing or also lacks sha256 retain the sentinel defaults — there is
    /// no authoritative source to reconstruct from.
    ///
    /// Note: <c>shard_index</c> and <c>envelope_version</c> are NOT backfilled.
    /// There is no authoritative source for shard_index outside the original
    /// manifest signature payload, and envelope_version=3 is the only protocol
    /// version that ever shipped with this schema, so the default is correct.
    /// </summary>
    public partial class ManifestProtocolFinalizationBackfill : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Backfill manifest_shards.sha256 and content_length from the
            // related shard where the related shard has authoritative values.
            // Postgres-only: uses UPDATE ... FROM. SQLite dev environments
            // never carried legacy rows for this column set (the column set
            // post-dates the SQLite dev fallback), so a no-op there is safe.
            if (migrationBuilder.ActiveProvider == "Npgsql.EntityFrameworkCore.PostgreSQL")
            {
                migrationBuilder.Sql(@"
                    UPDATE manifest_shards AS ms
                    SET
                        sha256 = COALESCE(s.sha256, ms.sha256),
                        content_length = CASE
                            WHEN s.size_bytes IS NOT NULL AND s.size_bytes > 0
                                THEN s.size_bytes
                            ELSE ms.content_length
                        END
                    FROM shards AS s
                    WHERE ms.shard_id = s.id
                      AND ms.sha256 = ''
                      AND ms.content_length = 0
                      AND s.sha256 IS NOT NULL
                      AND s.sha256 <> '';
                ");
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Intentional no-op: this is a one-way data backfill. We do not
            // restore the wrong sentinel defaults on rollback — the real
            // values are strictly more correct than the placeholders.
        }
    }
}
