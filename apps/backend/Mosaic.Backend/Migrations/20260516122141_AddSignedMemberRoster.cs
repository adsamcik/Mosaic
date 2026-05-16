using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddSignedMemberRoster : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<byte[]>(
                name: "member_roster_signature",
                table: "albums",
                type: "bytea",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "member_roster_signer_epoch_id",
                table: "albums",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "member_roster_version",
                table: "albums",
                type: "bigint",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "member_roster_signature",
                table: "albums");

            migrationBuilder.DropColumn(
                name: "member_roster_signer_epoch_id",
                table: "albums");

            migrationBuilder.DropColumn(
                name: "member_roster_version",
                table: "albums");
        }
    }
}
