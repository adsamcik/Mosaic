using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddAlbumContent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "sha256",
                table: "shards",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "album_contents",
                columns: table => new
                {
                    album_id = table.Column<Guid>(type: "TEXT", nullable: false),
                    encrypted_content = table.Column<byte[]>(type: "BLOB", nullable: false),
                    nonce = table.Column<byte[]>(type: "BLOB", nullable: false),
                    epoch_id = table.Column<int>(type: "INTEGER", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false),
                    created_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                    updated_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_album_contents", x => x.album_id);
                    table.ForeignKey(
                        name: "f_k_album_contents_albums_album_id",
                        column: x => x.album_id,
                        principalTable: "albums",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "album_contents");

            migrationBuilder.DropColumn(
                name: "sha256",
                table: "shards");
        }
    }
}
