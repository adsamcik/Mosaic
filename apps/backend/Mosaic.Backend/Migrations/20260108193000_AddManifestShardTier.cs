using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddManifestShardTier : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "tier",
                table: "manifest_shards",
                type: "integer",
                nullable: false,
                defaultValue: 3);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "tier",
                table: "manifest_shards");
        }
    }
}
