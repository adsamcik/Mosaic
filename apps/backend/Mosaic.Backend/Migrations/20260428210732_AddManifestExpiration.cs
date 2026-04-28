using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Mosaic.Backend.Data;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    [DbContext(typeof(MosaicDbContext))]
    [Migration("20260428210732_AddManifestExpiration")]
    public partial class AddManifestExpiration : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "expires_at",
                table: "manifests",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "i_x_manifests_expires_at",
                table: "manifests",
                column: "expires_at",
                filter: "expires_at IS NOT NULL");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "i_x_manifests_expires_at",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "expires_at",
                table: "manifests");
        }
    }
}
