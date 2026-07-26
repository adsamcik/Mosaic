using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class ProductionReadinessIntegrityAndPaginationV5 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "i_x_share_links_album_id",
                table: "share_links");

            migrationBuilder.AddColumn<byte[]>(
                name: "create_request_hash",
                table: "share_links",
                type: "bytea",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "created_at_unix_milliseconds",
                table: "share_links",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "expires_at_unix_milliseconds",
                table: "share_links",
                type: "bigint",
                nullable: true);

            // Preserve keyset ordering and active-link filtering for rows that
            // predate the normalized provider-independent timestamp columns.
            migrationBuilder.Sql(
                """
                UPDATE share_links
                SET created_at_unix_milliseconds =
                        FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::bigint,
                    expires_at_unix_milliseconds = CASE
                        WHEN expires_at IS NULL THEN NULL
                        ELSE FLOOR(EXTRACT(EPOCH FROM expires_at) * 1000)::bigint
                    END;
                """);

            migrationBuilder.AddColumn<int>(
                name: "envelope_version",
                table: "shards",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "finalize_request_hash",
                table: "manifests",
                type: "bytea",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "finalize_metadata_version",
                table: "manifests",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "tombstone_protocol_version",
                table: "manifests",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "tombstone_seq",
                table: "manifests",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "tombstone_version_created",
                table: "manifests",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "create_request_hash",
                table: "albums",
                type: "bytea",
                maxLength: 32,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "manifest_sequence_reservations",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    album_id = table.Column<Guid>(type: "uuid", nullable: false),
                    signer_pubkey = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    target_manifest_id = table.Column<Guid>(type: "uuid", nullable: false),
                    operation_id = table.Column<Guid>(type: "uuid", nullable: false),
                    operation_kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    manifest_seq = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    consumed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_manifest_sequence_reservations", x => x.id);
                    table.ForeignKey(
                        name: "f_k_manifest_sequence_reservations_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "manifest_sequence_states",
                columns: table => new
                {
                    album_id = table.Column<Guid>(type: "uuid", nullable: false),
                    signer_pubkey = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    last_allocated_sequence = table.Column<long>(type: "bigint", nullable: false),
                    last_consumed_sequence = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_manifest_sequence_states", x => new { x.album_id, x.signer_pubkey });
                    table.ForeignKey(
                        name: "f_k_manifest_sequence_states_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "tus_upload_lifecycles",
                columns: table => new
                {
                    file_id = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    album_id = table.Column<Guid>(type: "uuid", nullable: true),
                    reserved_bytes = table.Column<long>(type: "bigint", nullable: false),
                    upload_length = table.Column<long>(type: "bigint", nullable: false),
                    expected_content_sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    envelope_version = table.Column<int>(type: "integer", nullable: true),
                    state = table.Column<string>(type: "text", nullable: false),
                    reconciliation_attempts = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    received_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    committing_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    committed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    quarantined_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    quarantine_reason = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_tus_upload_lifecycles", x => x.file_id);
                    table.ForeignKey(
                        name: "f_k_tus_upload_lifecycles__users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "f_k_tus_upload_lifecycles_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "i_x_share_links_album_id_expires_at_unix_milliseconds",
                table: "share_links",
                columns: new[] { "album_id", "expires_at_unix_milliseconds" });

            migrationBuilder.CreateIndex(
                name: "ix_share_links_album_created_id",
                table: "share_links",
                columns: new[] { "album_id", "created_at_unix_milliseconds", "id" },
                descending: new[] { false, true, false });

            migrationBuilder.CreateIndex(
                name: "i_x_manifest_sequence_reservations_album_id_signer_pubkey_manif~",
                table: "manifest_sequence_reservations",
                columns: new[] { "album_id", "signer_pubkey", "manifest_seq" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "i_x_manifest_sequence_reservations_album_id_signer_pubkey_opera~",
                table: "manifest_sequence_reservations",
                columns: new[] { "album_id", "signer_pubkey", "operation_kind", "operation_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "i_x_manifest_sequence_reservations_album_id_target_manifest_id_~",
                table: "manifest_sequence_reservations",
                columns: new[] { "album_id", "target_manifest_id", "operation_kind" });

            migrationBuilder.CreateIndex(
                name: "i_x_manifest_sequence_reservations_operation_id",
                table: "manifest_sequence_reservations",
                column: "operation_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "i_x_tus_upload_lifecycles_album_id",
                table: "tus_upload_lifecycles",
                column: "album_id");

            migrationBuilder.CreateIndex(
                name: "i_x_tus_upload_lifecycles_state_updated_at",
                table: "tus_upload_lifecycles",
                columns: new[] { "state", "updated_at" });

            migrationBuilder.CreateIndex(
                name: "i_x_tus_upload_lifecycles_user_id",
                table: "tus_upload_lifecycles",
                column: "user_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "manifest_sequence_reservations");

            migrationBuilder.DropTable(
                name: "manifest_sequence_states");

            migrationBuilder.DropTable(
                name: "tus_upload_lifecycles");

            migrationBuilder.DropIndex(
                name: "i_x_share_links_album_id_expires_at_unix_milliseconds",
                table: "share_links");

            migrationBuilder.DropIndex(
                name: "ix_share_links_album_created_id",
                table: "share_links");

            migrationBuilder.DropColumn(
                name: "create_request_hash",
                table: "share_links");

            migrationBuilder.DropColumn(
                name: "created_at_unix_milliseconds",
                table: "share_links");

            migrationBuilder.DropColumn(
                name: "expires_at_unix_milliseconds",
                table: "share_links");

            migrationBuilder.DropColumn(
                name: "envelope_version",
                table: "shards");

            migrationBuilder.DropColumn(
                name: "finalize_request_hash",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "finalize_metadata_version",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "tombstone_protocol_version",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "tombstone_seq",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "tombstone_version_created",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "create_request_hash",
                table: "albums");

            migrationBuilder.CreateIndex(
                name: "i_x_share_links_album_id",
                table: "share_links",
                column: "album_id");
        }
    }
}
