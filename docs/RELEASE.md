# Release Process

This document describes how to release a new version of Mosaic.

## Prerequisites

- All tests passing on `main` branch
- CHANGELOG.md updated with release notes
- All package versions synchronized

## Release Checklist

### Before Release

- [ ] All tests pass locally: `.\scripts\run-tests.ps1 -Suite all`
- [ ] Tests pass in CI (check GitHub Actions)
- [ ] Docker images build successfully locally:
  ```bash
  docker build -t mosaic-backend-test -f apps/backend/Mosaic.Backend/Dockerfile apps/backend/Mosaic.Backend
  docker build -t mosaic-frontend-test -f apps/admin/Dockerfile .
  ```
- [ ] Full stack smoke test:
  ```bash
  docker compose up -d
  # Wait for health checks
  docker compose ps
  # Verify frontend accessible at http://localhost:8080
  docker compose down -v
  ```
- [ ] CHANGELOG.md has entry for new version with today's date
- [ ] Version numbers synchronized:
  - [ ] `apps/admin/package.json` - version field
  - [ ] `libs/crypto/package.json` - version field  
  - [ ] `apps/backend/Mosaic.Backend/Mosaic.Backend.csproj` - Version, AssemblyVersion, FileVersion

### Creating the Release

1. **Create and push the version tag:**
   ```bash
   # Ensure you're on main with latest changes
   git checkout main
   git pull origin main
   
   # Create annotated tag
   git tag -a v0.0.1 -m "Release v0.0.1"
   
   # Push the tag
   git push origin v0.0.1
   ```

2. **Monitor the publish workflow:**
   - Go to GitHub Actions → "Publish Docker Images"
   - Verify all jobs complete successfully:
     - [ ] Test job passes
     - [ ] Backend image published to ghcr.io
     - [ ] Frontend image published to ghcr.io
     - [ ] GitHub Release created

3. **Verify the release:**
   - Check the GitHub Release page for correct release notes
   - Verify Docker images are accessible:
     ```bash
     docker pull ghcr.io/eivindholvik/mosaic-backend:0.0.1
     docker pull ghcr.io/eivindholvik/mosaic-frontend:0.0.1
     ```

### After Release

- [ ] Announce the release (if applicable)
- [ ] Update any external documentation
- [ ] Bump version in package files for next development cycle (optional)

## Version Numbering

Mosaic follows [Semantic Versioning](https://semver.org/):

- **MAJOR** (0.x.x → 1.x.x): Breaking changes, API incompatibilities
- **MINOR** (x.0.x → x.1.x): New features, backward compatible
- **PATCH** (x.x.0 → x.x.1): Bug fixes, backward compatible

### Pre-1.0 Versioning

During the 0.x.x phase:
- Minor version bumps may include breaking changes
- API stability is not guaranteed
- Focus is on feature completion and stabilization

## Docker Image Tags

The publish workflow creates the following tags for each release:

| Tag | Example | Purpose |
|-----|---------|---------|
| `version` | `0.0.1` | Specific version |
| `major.minor` | `0.0` | Latest patch for minor version |
| `major` | `0` | Latest for major version (not for v0.x) |
| `latest` | `latest` | Most recent stable release |
| `sha-xxxxx` | `sha-a1b2c3d` | Specific commit (for non-release builds) |

## Troubleshooting

### Publish workflow failed

1. Check the GitHub Actions logs for specific error
2. Common issues:
   - Tests failed: Fix the failing tests and re-tag
   - Docker build failed: Fix Dockerfile and re-tag
   - Authentication failed: Check GITHUB_TOKEN permissions

### Re-releasing a version

If you need to re-release the same version (not recommended):

```bash
# Delete the tag locally and remotely
git tag -d v0.0.1
git push origin :refs/tags/v0.0.1

# Delete the GitHub Release (via web UI)

# Re-create the tag
git tag -a v0.0.1 -m "Release v0.0.1"
git push origin v0.0.1
```

### Manual image push (emergency)

If CI is broken but you need to publish:

```bash
# Login to GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Build and push manually
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/eivindholvik/mosaic-backend:0.0.1 \
  -f apps/backend/Mosaic.Backend/Dockerfile \
  apps/backend/Mosaic.Backend --push

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/eivindholvik/mosaic-frontend:0.0.1 \
  -f apps/admin/Dockerfile . --push
```

## Files Updated Per Release

| File | Update Needed |
|------|---------------|
| `CHANGELOG.md` | Add release section with date |
| `apps/admin/package.json` | Update `version` field |
| `libs/crypto/package.json` | Update `version` field |
| `apps/backend/Mosaic.Backend/Mosaic.Backend.csproj` | Update version properties |
