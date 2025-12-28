using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddQuotaAndAdminFeatures : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "is_admin",
                table: "users",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "current_album_count",
                table: "user_quotas",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "max_albums",
                table: "user_quotas",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "album_limits",
                columns: table => new
                {
                    album_id = table.Column<Guid>(type: "TEXT", nullable: false),
                    max_photos = table.Column<int>(type: "INTEGER", nullable: true),
                    max_size_bytes = table.Column<long>(type: "INTEGER", nullable: true),
                    current_photo_count = table.Column<int>(type: "INTEGER", nullable: false),
                    current_size_bytes = table.Column<long>(type: "INTEGER", nullable: false),
                    updated_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_album_limits", x => x.album_id);
                    table.ForeignKey(
                        name: "f_k_album_limits_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "system_settings",
                columns: table => new
                {
                    key = table.Column<string>(type: "TEXT", nullable: false),
                    value = table.Column<string>(type: "TEXT", nullable: false),
                    updated_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                    updated_by = table.Column<Guid>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_system_settings", x => x.key);
                    table.ForeignKey(
                        name: "f_k_system_settings__users_updated_by",
                        column: x => x.updated_by,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "i_x_system_settings_updated_by",
                table: "system_settings",
                column: "updated_by");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "album_limits");

            migrationBuilder.DropTable(
                name: "system_settings");

            migrationBuilder.DropColumn(
                name: "is_admin",
                table: "users");

            migrationBuilder.DropColumn(
                name: "current_album_count",
                table: "user_quotas");

            migrationBuilder.DropColumn(
                name: "max_albums",
                table: "user_quotas");
        }
    }
}
