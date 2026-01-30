using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Data;

public class MosaicDbContext : DbContext
{
    public MosaicDbContext(DbContextOptions<MosaicDbContext> options) : base(options) { }

    public DbSet<User> Users => Set<User>();
    public DbSet<Album> Albums => Set<Album>();
    public DbSet<AlbumMember> AlbumMembers => Set<AlbumMember>();
    public DbSet<EpochKey> EpochKeys => Set<EpochKey>();
    public DbSet<Manifest> Manifests => Set<Manifest>();
    public DbSet<Shard> Shards => Set<Shard>();
    public DbSet<ManifestShard> ManifestShards => Set<ManifestShard>();
    public DbSet<UserQuota> UserQuotas => Set<UserQuota>();
    public DbSet<ShareLink> ShareLinks => Set<ShareLink>();
    public DbSet<LinkEpochKey> LinkEpochKeys => Set<LinkEpochKey>();
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<AuthChallenge> AuthChallenges => Set<AuthChallenge>();
    public DbSet<SystemSetting> SystemSettings => Set<SystemSetting>();
    public DbSet<AlbumLimits> AlbumLimits => Set<AlbumLimits>();
    public DbSet<AlbumContent> AlbumContents => Set<AlbumContent>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // User
        modelBuilder.Entity<User>(e =>
        {
            e.HasIndex(u => u.AuthSub).IsUnique();
            e.Property(u => u.RowVersion).IsConcurrencyToken();
        });

        // Album
        modelBuilder.Entity<Album>(e =>
        {
            e.HasOne(a => a.Owner)
                .WithMany(u => u.OwnedAlbums)
                .HasForeignKey(a => a.OwnerId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasIndex(a => a.OwnerId);

            // Index for efficient expired album cleanup queries
            e.HasIndex(a => a.ExpiresAt)
                .HasFilter("expires_at IS NOT NULL");

            e.Property(a => a.RowVersion).IsConcurrencyToken();
        });

        // AlbumContent (1:1 with Album)
        modelBuilder.Entity<AlbumContent>(e =>
        {
            e.HasKey(ac => ac.AlbumId);

            e.HasOne(ac => ac.Album)
                .WithOne()
                .HasForeignKey<AlbumContent>(ac => ac.AlbumId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        // AlbumMember
        modelBuilder.Entity<AlbumMember>(e =>
        {
            e.HasKey(am => new { am.AlbumId, am.UserId });

            e.HasOne(am => am.Album)
                .WithMany(a => a.Members)
                .HasForeignKey(am => am.AlbumId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(am => am.User)
                .WithMany(u => u.Memberships)
                .HasForeignKey(am => am.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(am => am.Inviter)
                .WithMany()
                .HasForeignKey(am => am.InvitedBy)
                .OnDelete(DeleteBehavior.SetNull);

            e.HasIndex(am => am.UserId);
            e.HasIndex(am => am.AlbumId)
                .HasFilter("revoked_at IS NULL");
        });

        // EpochKey
        modelBuilder.Entity<EpochKey>(e =>
        {
            e.HasOne(ek => ek.Album)
                .WithMany(a => a.EpochKeys)
                .HasForeignKey(ek => ek.AlbumId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(ek => ek.Recipient)
                .WithMany(u => u.EpochKeys)
                .HasForeignKey(ek => ek.RecipientId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasIndex(ek => new { ek.AlbumId, ek.RecipientId, ek.EpochId }).IsUnique();
            e.HasIndex(ek => new { ek.RecipientId, ek.AlbumId });
        });

        // Manifest
        modelBuilder.Entity<Manifest>(e =>
        {
            e.HasOne(m => m.Album)
                .WithMany(a => a.Manifests)
                .HasForeignKey(m => m.AlbumId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasIndex(m => new { m.AlbumId, m.VersionCreated });

            // Global query filter to exclude soft-deleted manifests
            e.HasQueryFilter(m => !m.IsDeleted);

            e.Property(m => m.RowVersion).IsConcurrencyToken();
        });

        // Shard
        modelBuilder.Entity<Shard>(e =>
        {
            e.HasOne(s => s.Uploader)
                .WithMany()
                .HasForeignKey(s => s.UploaderId)
                .OnDelete(DeleteBehavior.SetNull);

            e.HasIndex(s => s.PendingExpiresAt)
                .HasFilter("status = 'PENDING'");

            e.Property(s => s.Status)
                .HasConversion<string>();
        });

        // ManifestShard
        modelBuilder.Entity<ManifestShard>(e =>
        {
            e.HasKey(ms => new { ms.ManifestId, ms.ShardId });
            e.HasIndex(ms => ms.ShardId);

            // Tier column with default value for backward compatibility
            e.Property(ms => ms.Tier)
                .HasDefaultValue((int)ShardTier.Original);

            e.HasOne(ms => ms.Manifest)
                .WithMany(m => m.ManifestShards)
                .HasForeignKey(ms => ms.ManifestId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne(ms => ms.Shard)
                .WithMany(s => s.ManifestShards)
                .HasForeignKey(ms => ms.ShardId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        // UserQuota
        modelBuilder.Entity<UserQuota>(e =>
        {
            e.HasKey(q => q.UserId);
            e.HasOne(q => q.User)
                .WithOne(u => u.Quota)
                .HasForeignKey<UserQuota>(q => q.UserId);
        });

        // SystemSetting
        modelBuilder.Entity<SystemSetting>(e =>
        {
            e.HasKey(s => s.Key);
            e.HasOne(s => s.UpdatedByUser)
                .WithMany()
                .HasForeignKey(s => s.UpdatedBy)
                .OnDelete(DeleteBehavior.SetNull);
        });

        // AlbumLimits
        modelBuilder.Entity<AlbumLimits>(e =>
        {
            e.HasKey(al => al.AlbumId);
            e.HasOne(al => al.Album)
                .WithOne(a => a.Limits)
                .HasForeignKey<AlbumLimits>(al => al.AlbumId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        // ShareLink
        modelBuilder.Entity<ShareLink>(e =>
        {
            e.HasOne(sl => sl.Album)
                .WithMany()
                .HasForeignKey(sl => sl.AlbumId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasIndex(sl => sl.LinkId).IsUnique();
            e.HasIndex(sl => sl.AlbumId);
        });

        // LinkEpochKey
        modelBuilder.Entity<LinkEpochKey>(e =>
        {
            e.HasOne(lek => lek.ShareLink)
                .WithMany(sl => sl.LinkEpochKeys)
                .HasForeignKey(lek => lek.ShareLinkId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasIndex(lek => new { lek.ShareLinkId, lek.EpochId, lek.Tier });
        });

        // Session
        modelBuilder.Entity<Session>(e =>
        {
            e.HasOne(s => s.User)
                .WithMany(u => u.Sessions)
                .HasForeignKey(s => s.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasIndex(s => s.TokenHash);
            e.HasIndex(s => s.UserId);
            e.HasIndex(s => s.ExpiresAt);
        });

        // AuthChallenge
        modelBuilder.Entity<AuthChallenge>(e =>
        {
            e.HasIndex(ac => ac.Username);
            e.HasIndex(ac => ac.ExpiresAt);
        });

        // Use snake_case for PostgreSQL
        foreach (var entity in modelBuilder.Model.GetEntityTypes())
        {
            var tableName = entity.GetTableName();
            if (tableName != null)
            {
                entity.SetTableName(ToSnakeCase(tableName));
            }

            foreach (var property in entity.GetProperties())
            {
                property.SetColumnName(ToSnakeCase(property.Name));
            }

            foreach (var key in entity.GetKeys())
            {
                var keyName = key.GetName();
                if (keyName != null)
                {
                    key.SetName(ToSnakeCase(keyName));
                }
            }

            foreach (var foreignKey in entity.GetForeignKeys())
            {
                var fkName = foreignKey.GetConstraintName();
                if (fkName != null)
                {
                    foreignKey.SetConstraintName(ToSnakeCase(fkName));
                }
            }

            foreach (var index in entity.GetIndexes())
            {
                var indexName = index.GetDatabaseName();
                if (indexName != null)
                {
                    index.SetDatabaseName(ToSnakeCase(indexName));
                }
            }
        }
    }

    private static string ToSnakeCase(string name) =>
        string.Concat(name.Select((c, i) =>
            i > 0 && char.IsUpper(c) ? "_" + char.ToLower(c) : char.ToLower(c).ToString()));
}
