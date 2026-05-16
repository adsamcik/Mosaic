using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddTombstoneSignature : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<byte[]>(
                name: "tombstone_signature",
                table: "manifests",
                type: "bytea",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "tombstone_signer_epoch_id",
                table: "manifests",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "tombstone_signature",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "tombstone_signer_epoch_id",
                table: "manifests");
        }
    }
}
