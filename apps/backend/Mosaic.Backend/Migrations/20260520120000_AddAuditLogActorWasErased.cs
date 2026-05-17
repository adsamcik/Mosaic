using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <summary>
    /// v1.0.1 s15 — GDPR Article 17 right-to-erasure.
    ///
    /// Adds <c>actor_was_erased</c> to <c>audit_log_entries</c> so we can
    /// distinguish three logical states on the existing nullable
    /// <c>actor_user_id</c> column:
    ///
    /// <list type="bullet">
    ///   <item><description><c>actor_user_id IS NOT NULL</c> — normal authenticated event.</description></item>
    ///   <item><description><c>actor_user_id IS NULL</c> AND <c>actor_was_erased = false</c> — pre-auth or system event (existing semantics, default).</description></item>
    ///   <item><description><c>actor_user_id IS NULL</c> AND <c>actor_was_erased = true</c> — actor existed but invoked the right-to-erasure flow.</description></item>
    /// </list>
    ///
    /// The column is non-nullable with a <c>false</c> default so every
    /// existing row gets the correct historical meaning without a backfill.
    /// </summary>
    public partial class AddAuditLogActorWasErased : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "actor_was_erased",
                table: "audit_log_entries",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "actor_was_erased",
                table: "audit_log_entries");
        }
    }
}
