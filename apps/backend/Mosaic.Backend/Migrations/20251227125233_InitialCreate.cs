using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "users",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    auth_sub = table.Column<string>(type: "text", nullable: false),
                    identity_pubkey = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_users", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "albums",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    owner_id = table.Column<Guid>(type: "uuid", nullable: false),
                    current_epoch_id = table.Column<int>(type: "integer", nullable: false),
                    current_version = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_albums", x => x.id);
                    table.ForeignKey(
                        name: "f_k_albums__users_owner_id",
                        column: x => x.owner_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "shards",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    uploader_id = table.Column<Guid>(type: "uuid", nullable: true),
                    storage_key = table.Column<string>(type: "text", nullable: false),
                    size_bytes = table.Column<long>(type: "bigint", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    status_updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    pending_expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_shards", x => x.id);
                    table.ForeignKey(
                        name: "f_k_shards__users_uploader_id",
                        column: x => x.uploader_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "user_quotas",
                columns: table => new
                {
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    max_storage_bytes = table.Column<long>(type: "bigint", nullable: false),
                    used_storage_bytes = table.Column<long>(type: "bigint", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_user_quotas", x => x.user_id);
                    table.ForeignKey(
                        name: "f_k_user_quotas_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "album_members",
                columns: table => new
                {
                    album_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    invited_by = table.Column<Guid>(type: "uuid", nullable: true),
                    joined_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_album_members", x => new { x.album_id, x.user_id });
                    table.ForeignKey(
                        name: "f_k_album_members__users_invited_by",
                        column: x => x.invited_by,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "f_k_album_members__users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "f_k_album_members_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "epoch_keys",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    album_id = table.Column<Guid>(type: "uuid", nullable: false),
                    recipient_id = table.Column<Guid>(type: "uuid", nullable: false),
                    epoch_id = table.Column<int>(type: "integer", nullable: false),
                    encrypted_key_bundle = table.Column<byte[]>(type: "bytea", nullable: false),
                    owner_signature = table.Column<byte[]>(type: "bytea", nullable: false),
                    sharer_pubkey = table.Column<byte[]>(type: "bytea", nullable: false),
                    sign_pubkey = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_epoch_keys", x => x.id);
                    table.ForeignKey(
                        name: "f_k_epoch_keys__users_recipient_id",
                        column: x => x.recipient_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "f_k_epoch_keys_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "manifests",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    album_id = table.Column<Guid>(type: "uuid", nullable: false),
                    version_created = table.Column<long>(type: "bigint", nullable: false),
                    is_deleted = table.Column<bool>(type: "boolean", nullable: false),
                    encrypted_meta = table.Column<byte[]>(type: "bytea", nullable: false),
                    signature = table.Column<string>(type: "text", nullable: false),
                    signer_pubkey = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_manifests", x => x.id);
                    table.ForeignKey(
                        name: "f_k_manifests_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "manifest_shards",
                columns: table => new
                {
                    manifest_id = table.Column<Guid>(type: "uuid", nullable: false),
                    shard_id = table.Column<Guid>(type: "uuid", nullable: false),
                    chunk_index = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_manifest_shards", x => new { x.manifest_id, x.shard_id });
                    table.ForeignKey(
                        name: "f_k_manifest_shards__shards_shard_id",
                        column: x => x.shard_id,
                        principalTable: "shards",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "f_k_manifest_shards_manifests_manifest_id",
                        column: x => x.manifest_id,
                        principalTable: "manifests",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "i_x_album_members_album_id",
                table: "album_members",
                column: "album_id",
                filter: "revoked_at IS NULL");

            migrationBuilder.CreateIndex(
                name: "i_x_album_members_invited_by",
                table: "album_members",
                column: "invited_by");

            migrationBuilder.CreateIndex(
                name: "i_x_album_members_user_id",
                table: "album_members",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "i_x_albums_owner_id",
                table: "albums",
                column: "owner_id");

            migrationBuilder.CreateIndex(
                name: "i_x_epoch_keys_album_id_recipient_id_epoch_id",
                table: "epoch_keys",
                columns: new[] { "album_id", "recipient_id", "epoch_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "i_x_epoch_keys_recipient_id_album_id",
                table: "epoch_keys",
                columns: new[] { "recipient_id", "album_id" });

            migrationBuilder.CreateIndex(
                name: "i_x_manifest_shards_shard_id",
                table: "manifest_shards",
                column: "shard_id");

            migrationBuilder.CreateIndex(
                name: "i_x_manifests_album_id_version_created",
                table: "manifests",
                columns: new[] { "album_id", "version_created" });

            migrationBuilder.CreateIndex(
                name: "i_x_shards_pending_expires_at",
                table: "shards",
                column: "pending_expires_at",
                filter: "status = 'PENDING'");

            migrationBuilder.CreateIndex(
                name: "i_x_shards_uploader_id",
                table: "shards",
                column: "uploader_id");

            migrationBuilder.CreateIndex(
                name: "i_x_users_auth_sub",
                table: "users",
                column: "auth_sub",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "album_members");

            migrationBuilder.DropTable(
                name: "epoch_keys");

            migrationBuilder.DropTable(
                name: "manifest_shards");

            migrationBuilder.DropTable(
                name: "user_quotas");

            migrationBuilder.DropTable(
                name: "shards");

            migrationBuilder.DropTable(
                name: "manifests");

            migrationBuilder.DropTable(
                name: "albums");

            migrationBuilder.DropTable(
                name: "users");
        }
    }
}
