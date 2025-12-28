using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class AddLocalAuth : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<byte[]>(
                name: "account_salt",
                table: "users",
                type: "bytea",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "auth_pubkey",
                table: "users",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "user_salt",
                table: "users",
                type: "bytea",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "wrapped_account_key",
                table: "users",
                type: "bytea",
                nullable: true);

            migrationBuilder.AddColumn<byte[]>(
                name: "wrapped_identity_seed",
                table: "users",
                type: "bytea",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "auth_challenges",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    username = table.Column<string>(type: "text", nullable: false),
                    challenge = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    is_used = table.Column<bool>(type: "boolean", nullable: false),
                    ip_address = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_auth_challenges", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "sessions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    token_hash = table.Column<byte[]>(type: "bytea", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    last_seen_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    user_agent = table.Column<string>(type: "text", nullable: true),
                    ip_address = table.Column<string>(type: "text", nullable: true),
                    device_name = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("p_k_sessions", x => x.id);
                    table.ForeignKey(
                        name: "f_k_sessions__users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "i_x_auth_challenges_expires_at",
                table: "auth_challenges",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "i_x_auth_challenges_username",
                table: "auth_challenges",
                column: "username");

            migrationBuilder.CreateIndex(
                name: "i_x_sessions_expires_at",
                table: "sessions",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "i_x_sessions_token_hash",
                table: "sessions",
                column: "token_hash");

            migrationBuilder.CreateIndex(
                name: "i_x_sessions_user_id",
                table: "sessions",
                column: "user_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "auth_challenges");

            migrationBuilder.DropTable(
                name: "sessions");

            migrationBuilder.DropColumn(
                name: "account_salt",
                table: "users");

            migrationBuilder.DropColumn(
                name: "auth_pubkey",
                table: "users");

            migrationBuilder.DropColumn(
                name: "user_salt",
                table: "users");

            migrationBuilder.DropColumn(
                name: "wrapped_account_key",
                table: "users");

            migrationBuilder.DropColumn(
                name: "wrapped_identity_seed",
                table: "users");
        }
    }
}
