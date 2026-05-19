using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <summary>
    /// v1.0.1 release blocker fix — bootstrap the <c>idempotency_records</c> table on fresh
    /// PostgreSQL deployments.
    ///
    /// Historically the table was introduced via a raw
    /// <c>V20260429120000__AddIdempotencyRecords.sql</c> file that was never wired into the
    /// EF migration chain, so <c>db.Database.MigrateAsync()</c> on a fresh database produced
    /// the full EF schema EXCEPT for this table. Any authenticated POST/PUT/DELETE/PATCH
    /// then hit Postgres <c>42P01: relation "idempotency_records" does not exist</c> via
    /// <c>IdempotencyMiddleware</c> and returned HTTP 500.
    ///
    /// The model snapshot already includes the table, so this migration only carries the
    /// raw DDL. <c>IF NOT EXISTS</c> guards make it a safe no-op on existing dev databases
    /// that already applied the orphaned SQL file manually.
    /// </summary>
    public partial class BootstrapIdempotencyRecords : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
                CREATE TABLE IF NOT EXISTS idempotency_records (
                    user_id uuid NOT NULL,
                    idempotency_key character varying(255) NOT NULL,
                    request_hash bytea NOT NULL,
                    response_status integer NOT NULL,
                    response_body_hash bytea NOT NULL,
                    response_body bytea NOT NULL,
                    response_headers_subset text NOT NULL,
                    created_at timestamp with time zone NOT NULL DEFAULT now(),
                    CONSTRAINT pk_idempotency_records PRIMARY KEY (user_id, idempotency_key),
                    CONSTRAINT fk_idempotency_records_users_user_id
                        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS ix_idempotency_records_created_at
                    ON idempotency_records (created_at);
            ");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TABLE IF EXISTS idempotency_records;");
        }
    }
}
