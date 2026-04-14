# syntax=docker/dockerfile:1

# Mosaic Backend - .NET 10 ASP.NET Core API
# Multi-stage build for optimized production image

# Build stage — use build platform for fast native compilation
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG TARGETARCH
WORKDIR /src

# Copy project file and restore dependencies for target architecture
COPY Mosaic.Backend.csproj ./
RUN dotnet restore -a $TARGETARCH

# Copy source and publish for target architecture
COPY . .
RUN dotnet publish -c Release -a $TARGETARCH --no-restore -o /app/publish

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble AS runtime
WORKDIR /app

# OCI Image Labels (overwritten by docker/metadata-action in CI)
LABEL org.opencontainers.image.title="Mosaic Backend" \
      org.opencontainers.image.description="Zero-knowledge encrypted photo gallery backend API" \
      org.opencontainers.image.url="https://github.com/adsamcik/Mosaic" \
      org.opencontainers.image.source="https://github.com/adsamcik/Mosaic" \
      org.opencontainers.image.vendor="Mosaic Contributors" \
      org.opencontainers.image.licenses="MIT"

# Create non-root user for security
RUN groupadd -r mosaic && useradd -r -g mosaic mosaic

# Create data directories
RUN mkdir -p /app/data/blobs && chown -R mosaic:mosaic /app/data

# Copy published application
COPY --from=build /app/publish .

# Switch to non-root user
USER mosaic

# Expose port
EXPOSE 8080

# Health check — use wget (included in Ubuntu Noble base) to avoid
# installing curl which fails under QEMU in multi-arch Docker builds
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:8080/health || exit 1

# Set environment variables
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production
ENV DOTNET_EnableDiagnostics=0
ENV COMPlus_EnableDiagnostics=0

ENTRYPOINT ["dotnet", "Mosaic.Backend.dll"]
