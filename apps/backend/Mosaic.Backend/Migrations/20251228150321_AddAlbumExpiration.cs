using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddAlbumExpiration : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "expiration_warning_days",
                table: "albums",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "expires_at",
                table: "albums",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "i_x_albums_expires_at",
                table: "albums",
                column: "expires_at",
                filter: "expires_at IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "i_x_albums_expires_at",
                table: "albums");

            migrationBuilder.DropColumn(
                name: "expiration_warning_days",
                table: "albums");

            migrationBuilder.DropColumn(
                name: "expires_at",
                table: "albums");
        }
    }
}
