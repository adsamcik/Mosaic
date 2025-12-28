using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddShareLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "share_links",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    link_id = table.Column<byte[]>(type: "bytea", nullable: false),
                    album_id = table.Column<Guid>(type: "uuid", nullable: false),
                    access_tier = table.Column<int>(type: "integer", nullable: false),
                    owner_encrypted_secret = table.Column<byte[]>(type: "bytea", nullable: true),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    max_uses = table.Column<int>(type: "integer", nullable: true),
                    use_count = table.Column<int>(type: "integer", nullable: false),
                    is_revoked = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_share_links", x => x.id);
                    table.ForeignKey(
                        name: "f_k_share_links_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "link_epoch_keys",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    share_link_id = table.Column<Guid>(type: "uuid", nullable: false),
                    epoch_id = table.Column<int>(type: "integer", nullable: false),
                    tier = table.Column<int>(type: "integer", nullable: false),
                    wrapped_nonce = table.Column<byte[]>(type: "bytea", nullable: false),
                    wrapped_key = table.Column<byte[]>(type: "bytea", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_link_epoch_keys", x => x.id);
                    table.ForeignKey(
                        name: "f_k_link_epoch_keys__share_links_share_link_id",
                        column: x => x.share_link_id,
                        principalTable: "share_links",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "i_x_link_epoch_keys_share_link_id_epoch_id_tier",
                table: "link_epoch_keys",
                columns: new[] { "share_link_id", "epoch_id", "tier" });

            migrationBuilder.CreateIndex(
                name: "i_x_share_links_album_id",
                table: "share_links",
                column: "album_id");

            migrationBuilder.CreateIndex(
                name: "i_x_share_links_link_id",
                table: "share_links",
                column: "link_id",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "link_epoch_keys");

            migrationBuilder.DropTable(
                name: "share_links");
        }
    }
}
