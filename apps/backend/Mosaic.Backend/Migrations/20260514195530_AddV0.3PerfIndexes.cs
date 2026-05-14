using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddV03PerfIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "row_version",
                table: "shards",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.CreateIndex(
                name: "ix_users_identity_pubkey",
                table: "users",
                column: "identity_pubkey");

            migrationBuilder.CreateIndex(
                name: "ix_epoch_keys_album_epoch",
                table: "epoch_keys",
                columns: new[] { "album_id", "epoch_id" });

            migrationBuilder.CreateIndex(
                name: "ix_epoch_keys_album_signpubkey",
                table: "epoch_keys",
                columns: new[] { "album_id", "sign_pubkey" });

            migrationBuilder.CreateIndex(
                name: "ix_auth_challenges_ip_created",
                table: "auth_challenges",
                columns: new[] { "ip_address", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_auth_challenges_ip_used_created",
                table: "auth_challenges",
                columns: new[] { "ip_address", "is_used", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_albums_owner_created",
                table: "albums",
                columns: new[] { "owner_id", "created_at" },
                descending: new[] { false, true });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_users_identity_pubkey",
                table: "users");

            migrationBuilder.DropIndex(
                name: "ix_epoch_keys_album_epoch",
                table: "epoch_keys");

            migrationBuilder.DropIndex(
                name: "ix_epoch_keys_album_signpubkey",
                table: "epoch_keys");

            migrationBuilder.DropIndex(
                name: "ix_auth_challenges_ip_created",
                table: "auth_challenges");

            migrationBuilder.DropIndex(
                name: "ix_auth_challenges_ip_used_created",
                table: "auth_challenges");

            migrationBuilder.DropIndex(
                name: "ix_albums_owner_created",
                table: "albums");

            migrationBuilder.DropColumn(
                name: "row_version",
                table: "shards");
        }
    }
}
