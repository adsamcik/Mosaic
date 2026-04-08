# syntax=docker/dockerfile:1

# Mosaic Backend - .NET 10 ASP.NET Core API
# Multi-stage build for optimized production image

# Build stage
FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:f061e5a7532b36fa1d1b684857fe1f504ba92115b9934f154643266613c44c62 AS build
WORKDIR /src

# Copy project file and restore dependencies
COPY Mosaic.Backend.csproj ./
RUN dotnet restore

# Copy source and build
COPY . .
RUN dotnet publish -c Release -o /app/publish --no-restore

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:ccdca44cd4f256d50187f920dc8ccc2a9ea7a8a4597ac1d51e08fddb2e3b3205 AS runtime
WORKDIR /app

# OCI Image Labels (overwritten by docker/metadata-action in CI)
LABEL org.opencontainers.image.title="Mosaic Backend" \
      org.opencontainers.image.description="Zero-knowledge encrypted photo gallery backend API" \
      org.opencontainers.image.url="https://github.com/adsamcik/Mosaic" \
      org.opencontainers.image.source="https://github.com/adsamcik/Mosaic" \
      org.opencontainers.image.vendor="Mosaic Contributors" \
      org.opencontainers.image.licenses="MIT"

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

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

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Set environment variables
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production

ENTRYPOINT ["dotnet", "Mosaic.Backend.dll"]
