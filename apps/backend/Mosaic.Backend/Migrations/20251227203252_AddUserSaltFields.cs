using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddUserSaltFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<byte[]>(
                name: "encrypted_salt",
                table: "users",
                type: "bytea",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "salt_nonce",
                table: "users",
                type: "bytea",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "encrypted_salt",
                table: "users");

            migrationBuilder.DropColumn(
                name: "salt_nonce",
                table: "users");
        }
    }
}
