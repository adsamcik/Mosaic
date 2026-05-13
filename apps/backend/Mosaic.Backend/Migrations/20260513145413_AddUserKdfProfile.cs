using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddUserKdfProfile : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // up: Backfill existing pre-v1 users with the desktop Argon2id profile.
            // Pre-v1 dev users registered with mobile/low-memory parameters may need a local database reset.
            migrationBuilder.AddColumn<int>(
                name: "kdf_memory_kib",
                table: "users",
                type: "integer",
                nullable: false,
                defaultValue: 65536);

            migrationBuilder.AddColumn<int>(
                name: "kdf_iterations",
                table: "users",
                type: "integer",
                nullable: false,
                defaultValue: 3);

            migrationBuilder.AddColumn<int>(
                name: "kdf_parallelism",
                table: "users",
                type: "integer",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<byte>(
                name: "kdf_alg_version",
                table: "users",
                type: "smallint",
                nullable: false,
                defaultValue: (byte)19);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "kdf_memory_kib",
                table: "users");

            migrationBuilder.DropColumn(
                name: "kdf_iterations",
                table: "users");

            migrationBuilder.DropColumn(
                name: "kdf_parallelism",
                table: "users");

            migrationBuilder.DropColumn(
                name: "kdf_alg_version",
                table: "users");
        }
    }
}
