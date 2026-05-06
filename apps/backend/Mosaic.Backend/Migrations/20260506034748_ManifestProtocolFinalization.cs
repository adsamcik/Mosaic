using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Mosaic.Backend.Migrations
{
    /// <inheritdoc />
    public partial class ManifestProtocolFinalization : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "asset_type",
                table: "manifests",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "Image");

            migrationBuilder.AddColumn<byte[]>(
                name: "encrypted_meta_sidecar",
                table: "manifests",
                type: "bytea",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "metadata_version",
                table: "manifests",
                type: "bigint",
                nullable: false,
                defaultValue: 1L);

            migrationBuilder.AddColumn<int>(
                name: "protocol_version",
                table: "manifests",
                type: "integer",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<long>(
                name: "content_length",
                table: "manifest_shards",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<int>(
                name: "envelope_version",
                table: "manifest_shards",
                type: "integer",
                nullable: false,
                defaultValue: 3);

            migrationBuilder.AddColumn<string>(
                name: "sha256",
                table: "manifest_shards",
                type: "character varying(64)",
                maxLength: 64,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<int>(
                name: "shard_index",
                table: "manifest_shards",
                type: "integer",
                nullable: false,
                defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "asset_type",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "encrypted_meta_sidecar",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "metadata_version",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "protocol_version",
                table: "manifests");

            migrationBuilder.DropColumn(
                name: "content_length",
                table: "manifest_shards");

            migrationBuilder.DropColumn(
                name: "envelope_version",
                table: "manifest_shards");

            migrationBuilder.DropColumn(
                name: "sha256",
                table: "manifest_shards");

            migrationBuilder.DropColumn(
                name: "shard_index",
                table: "manifest_shards");
        }
    }
}
