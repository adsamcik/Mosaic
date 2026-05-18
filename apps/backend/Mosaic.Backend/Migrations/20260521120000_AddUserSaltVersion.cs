using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <summary>
    /// v1.0.x s38 — password rotation.
    ///
    /// Adds <c>salt_version</c> to <c>users</c>: a monotonically-increasing
    /// counter bumped by <c>POST /api/v1/auth/password-rotation</c> every
    /// time the user replaces their password-derived key material
    /// (<c>user_salt</c>, <c>auth_pubkey</c>, <c>wrapped_account_key</c>).
    /// Clients use this version to detect when their cached unwrapped keys
    /// are stale and need to be re-derived from the new password.
    ///
    /// Defaults to 1 so legacy rows have a sensible "never rotated" baseline
    /// distinguishable from "rotated zero times after migration."
    /// </summary>
    public partial class AddUserSaltVersion : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "salt_version",
                table: "users",
                type: "integer",
                nullable: false,
                defaultValue: 1);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "salt_version",
                table: "users");
        }
    }
}
