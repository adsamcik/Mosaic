# Development Guide

This guide covers setting up and running the Mosaic development environment.

## Quick Start

```powershell
# Windows (PowerShell)
.\scripts\dev.ps1 start
```

```bash
# Linux/macOS
./scripts/dev.sh start
```

This single command starts:

- PostgreSQL database (Docker container)
- .NET backend with hot reload
- Vite frontend with HMR

Open <http://localhost:5173> when ready.

---

## Prerequisites

### Required Software

| Software | Version | Installation |
| -------- | ------- | ------------ |
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org) |
| **pnpm/npm** | Latest | Included with Node.js |
| **.NET SDK** | 10+ | [dotnet.microsoft.com](https://dotnet.microsoft.com/download) |
| **Docker** | Latest | [docker.com](https://www.docker.com/get-started) |

### Verify Installation

```bash
node --version    # Should show v20.x or higher
dotnet --version  # Should show 10.x or higher
docker --version  # Should show Docker version
```

---

## Development Methods

Choose the method that best fits your workflow:

| Method | Best For | Setup Effort |
| ------ | -------- | ------------ |
| **Dev Script** | Quick start, background services | ⭐ Easiest |
| **VS Code Tasks** | Integrated IDE experience | ⭐ Easy |
| **Manual** | Full control, debugging | Moderate |
| **Visual Studio** | .NET-focused development | Easy |

---

## Method 1: Development Script (Recommended)

The `dev.ps1` (Windows) / `dev.sh` (Linux/macOS) scripts manage all services as background processes.

### Starting Services

```powershell
# Start everything
.\scripts\dev.ps1 start

# Start specific services
.\scripts\dev.ps1 start db        # Just PostgreSQL
.\scripts\dev.ps1 start backend   # Just backend
.\scripts\dev.ps1 start frontend  # Just frontend
```

### Checking Status

```powershell
.\scripts\dev.ps1 status
```

Output:

```text
Mosaic Development Environment Status

  Database:  Running (port 5432)
  Backend:   Running (PID: 12345, port 5000)
  Frontend:  Running (PID: 12346, port 5173)

  URLs:
    Frontend: http://localhost:5173
    Backend:  http://localhost:5000
    Swagger:  http://localhost:5000/openapi/v1.json

```

### Viewing Logs

```powershell
# View last 50 lines (non-blocking)
.\scripts\dev.ps1 logs backend
.\scripts\dev.ps1 logs frontend
.\scripts\dev.ps1 logs db

# Live tail (interactive, Ctrl+C to exit)
.\scripts\dev.ps1 logs backend -f
.\scripts\dev.ps1 logs backend --follow

# Custom line count
.\scripts\dev.ps1 logs backend --tail=100
```

### Stopping Services

```powershell
# Stop everything
.\scripts\dev.ps1 stop

# Stop specific service
.\scripts\dev.ps1 stop backend
```

### Restarting Services

```powershell
# Restart everything
.\scripts\dev.ps1 restart

# Restart specific service
.\scripts\dev.ps1 restart backend
```

### Running Tests

```powershell
# Run all unit tests
.\scripts\dev.ps1 test

# Run specific test suites
.\scripts\dev.ps1 test unit      # All unit tests
.\scripts\dev.ps1 test e2e       # E2E tests (services must be running)

# E2E test options
.\scripts\dev.ps1 test e2e --headed              # Visible browser
.\scripts\dev.ps1 test e2e --project=firefox     # Specific browser
.\scripts\dev.ps1 test e2e auth.spec.ts          # Specific file
.\scripts\dev.ps1 test e2e --grep "login"        # Filter by name
```

### Resetting Environment

```powershell
# Reset database (keeps node_modules)
.\scripts\dev.ps1 reset

# Full reset (removes node_modules too)
.\scripts\dev.ps1 reset --full
```

---

## Method 2: VS Code Tasks

VS Code has preconfigured tasks for common operations.

### Running Tasks

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type "Tasks: Run Task"
3. Select a task:

| Task | Description |
| ---- | ----------- |
| **start-all** | Start crypto → backend → frontend (sequence) |
| **watch-backend** | Backend with hot reload |
| **watch-frontend** | Vite dev server with weak keys (for E2E) |
| **watch-frontend-production-crypto** | Vite with production crypto |
| **build-backend** | Build backend without running |
| **build-crypto** | Build crypto library |
| **test-all** | Run all test suites in parallel |
| **test-backend** | Run backend tests |
| **test-frontend** | Run frontend tests |
| **test-crypto** | Run crypto tests |

### Launch Configurations (F5)

For debugging, use launch configurations:

| Configuration | Description |
| ------------- | ----------- |
| **Backend + Frontend** | Start both, opens browser |
| **Full Stack (Debug Both)** | Debug both simultaneously |
| **Backend (.NET)** | API only with Swagger |

### Prerequisites for VS Code

1. Docker Desktop must be running (for PostgreSQL)
2. The crypto library must be built first:

   ```bash
   cd libs/crypto && npm install && npm run build
   ```

---

## Method 3: Manual Setup

For full control over each service:

### Step 1: Start PostgreSQL

```bash
docker compose -f docker-compose.dev.yml up -d postgres
```

Optionally add pgAdmin:

```bash
docker compose -f docker-compose.dev.yml --profile tools up -d
```

### Step 2: Build Crypto Library

```bash
cd libs/crypto
npm install
npm run build
```

### Step 3: Start Backend

```bash
cd apps/backend/Mosaic.Backend

# Set environment variables
export ASPNETCORE_ENVIRONMENT=Development
export ASPNETCORE_URLS=http://localhost:5000
export ConnectionStrings__Default="Host=localhost;Database=mosaic;Username=mosaic;Password=dev"

# Run with hot reload
dotnet watch run

# Or without hot reload
dotnet run
```

### Step 4: Start Frontend

```bash
cd apps/web
npm install
npm run dev
```

---

## Method 4: Visual Studio

For .NET-focused development:

1. Open `Mosaic.slnx` in Visual Studio 2022/2026
2. Set **Mosaic.Backend** as startup project
3. Press **F5** to run
4. For frontend, open a terminal and run:

   ```bash
   cd apps/web && npm install && npm run dev
   ```

---

## Service URLs

When running, services are available at:

| Service | URL | Purpose |
| ------- | --- | ------- |
| Frontend | <http://localhost:5173> | Main application |
| Backend | <http://localhost:5000> | API endpoints |
| OpenAPI Spec | <http://localhost:5000/openapi/v1.json> | API documentation |
| pgAdmin | <http://localhost:5050> | Database management (if started with `--profile tools`) |

---

## Authentication in Development

The development environment supports two authentication modes:

### Local Authentication (Default)

- Users can register/login with username + password
- No external identity provider needed
- Good for quick testing

### Proxy Authentication

For testing SSO integration:

```powershell
# Start backend with proxy auth only
.\scripts\dev.ps1 start backend --proxy-auth
```

Or set environment variable:

```bash
export Auth__ProxyAuthEnabled=true
export Auth__TrustedProxies__0="127.0.0.0/8"
```

---

## Database Management

### Accessing the Database

```bash
# Connect via psql
docker exec -it mosaic-postgres-dev psql -U mosaic -d mosaic

# Or use pgAdmin
docker compose -f docker-compose.dev.yml --profile tools up -d
# Open <http://localhost:5050> (admin@admin.com / admin)
```

### Resetting the Database

```powershell
# Via dev script
.\scripts\dev.ps1 reset

# Or manually
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d postgres
```

### Viewing Migrations

```bash
cd apps/backend/Mosaic.Backend
dotnet ef migrations list
```

---

## Building for Production

### Build Docker Images

```powershell
# Windows
.\scripts\docker-build.ps1

# Linux/macOS
./scripts/docker-build.sh
```

### Run Production Stack Locally

```powershell
# Windows
.\scripts\mosaic.ps1 start

# Linux/macOS
./scripts/mosaic.sh start
```

---

## Troubleshooting

### Port Already in Use

```powershell
# Check what's using a port
netstat -ano | findstr :5000
netstat -ano | findstr :5173

# Kill process by PID
taskkill /PID <pid> /F
```

### Docker Not Running

```text
❌ Docker is not running!
```

Solution: Start Docker Desktop and wait for it to fully initialize.

### Frontend Can't Connect to Backend

Check CORS settings in backend and ensure both services are running:

```powershell
.\scripts\dev.ps1 status
```

### Database Connection Failed

```bash
# Check if PostgreSQL container is running
docker ps | grep mosaic-postgres

# View database logs
docker logs mosaic-postgres-dev
```

### Crypto Library Not Built

If you see import errors for `@mosaic/crypto`:

```bash
cd libs/crypto
npm install
npm run build
```

### Hot Reload Not Working

Backend:

```bash
# Ensure you're using dotnet watch
dotnet watch run
```

Frontend:

```bash
# Vite HMR should work automatically
# Check browser console for WebSocket errors
```

---

## Environment Variables

### Backend

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `ASPNETCORE_ENVIRONMENT` | Development | Environment mode |
| `ASPNETCORE_URLS` | <http://localhost:5000> | Listen URL |
| `ConnectionStrings__Default` | (see below) | PostgreSQL connection |
| `Storage__Path` | ./data/blobs | Blob storage path |
| `Auth__LocalAuthEnabled` | true | Enable local auth |
| `Auth__ProxyAuthEnabled` | false | Enable proxy auth |

Default connection string:

```text
Host=localhost;Database=mosaic;Username=mosaic;Password=dev
```

### Frontend

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `VITE_API_URL` | <http://localhost:5000> | Backend API URL |
| `VITE_E2E_WEAK_KEYS` | false | Use weak keys for E2E testing |

---

## Tests

### Unit Tests

```bash
# All unit tests
.\scripts\dev.ps1 test unit

# Or individually:
cd libs/crypto && npm test        # Crypto tests
cd apps/web && npm run test:run # Frontend tests
cd apps/backend/Mosaic.Backend.Tests && dotnet test  # Backend tests
```

### E2E Tests

```bash
# Services must be running first
.\scripts\dev.ps1 start

# Run E2E tests
.\scripts\dev.ps1 test e2e

# Or via dedicated script
.\scripts\run-e2e-tests.ps1
```

### Coverage

```bash
cd libs/crypto && npm run test:coverage
cd apps/web && npm run test:coverage
```

---

## IDE Setup

### VS Code Extensions (Recommended)

- C# Dev Kit
- ESLint
- Prettier
- Volar (Vue/TypeScript)
- Docker

### Settings

The workspace includes recommended settings in `.vscode/settings.json`.

---

## Next Steps

- Read [ARCHITECTURE.md](ARCHITECTURE.md) for system design
- Review [SECURITY.md](SECURITY.md) for the cryptographic model
- Check [FEATURES.md](FEATURES.md) for implemented features
