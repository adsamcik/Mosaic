using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class ShareGrantsAndTusReservations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "share_link_grants",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    share_link_id = table.Column<Guid>(type: "uuid", nullable: false),
                    token_hash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: false),
                    granted_use_count = table.Column<int>(type: "integer", nullable: false),
                    expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_share_link_grants", x => x.id);
                    table.ForeignKey(
                        name: "f_k_share_link_grants_share_links_share_link_id",
                        column: x => x.share_link_id,
                        principalTable: "share_links",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "tus_upload_reservations",
                columns: table => new
                {
                    file_id = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    album_id = table.Column<Guid>(type: "uuid", nullable: true),
                    reserved_bytes = table.Column<long>(type: "bigint", nullable: false),
                    upload_length = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_tus_upload_reservations", x => x.file_id);
                    table.ForeignKey(
                        name: "f_k_tus_upload_reservations__users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "f_k_tus_upload_reservations_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "i_x_share_link_grants_expires_at",
                table: "share_link_grants",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "i_x_share_link_grants_share_link_id_token_hash",
                table: "share_link_grants",
                columns: new[] { "share_link_id", "token_hash" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "i_x_tus_upload_reservations_album_id",
                table: "tus_upload_reservations",
                column: "album_id");

            migrationBuilder.CreateIndex(
                name: "i_x_tus_upload_reservations_expires_at",
                table: "tus_upload_reservations",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "i_x_tus_upload_reservations_user_id",
                table: "tus_upload_reservations",
                column: "user_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "share_link_grants");

            migrationBuilder.DropTable(
                name: "tus_upload_reservations");
        }
    }
}
