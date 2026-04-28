# SPEC: Band 8 Final Validation Matrix

## Status

Ready for Band 8 execution. This Band 7 readiness lane documents and statically validates the matrix only; it must not run the expensive backend/web/Rust/Android/E2E suite.

## Scope

Band 8 owns execution of the full validation matrix after the parallel Band 3, Band 5, Band 6, and Band 7 lanes have merged. This spec prepares:

- the ordered validation matrix;
- prerequisites and service expectations;
- the output-capture contract for every expensive command;
- failure triage and fix-forward rerun policy;
- cleanup rules for validation artifacts.

## Inventory of Existing Validation Entrypoints

| Area | Existing command or script | Evidence |
|------|----------------------------|----------|
| Backend build/test | `dotnet build .\apps\backend\Mosaic.Backend\Mosaic.Backend.csproj`; `dotnet test .\apps\backend\Mosaic.Backend.Tests\Mosaic.Backend.Tests.csproj` | `.vscode\tasks.json` defines `build-backend` and `test-backend`. |
| Crypto library | `npm run build`; `npm test`; `npm run test:coverage`; `npm run lint`; `npm run typecheck` from `libs\crypto` | `libs\crypto\package.json` scripts. |
| Web frontend | `npm run typecheck`; `npm run lint`; `npm run build`; `npm run test:run` from `apps\web` | `apps\web\package.json` scripts. |
| Rust workspace | `.\scripts\rust-check.ps1` | Runs `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`, `cargo test --workspace --locked`, Rust boundary checks, and supply-chain checks. |
| Rust WASM bridge | `.\scripts\build-rust-wasm.ps1` | Builds `mosaic-wasm`, runs `wasm-bindgen`, and copies generated bindings into `apps\web\src\generated\mosaic-wasm`. |
| Rust Android/UniFFI bridge | `.\scripts\build-rust-android.ps1` | Builds `mosaic-uniffi` for Android ABIs and generates Kotlin bindings into `target\android\kotlin`. |
| Android shell | `.\scripts\test-android-shell.ps1` | Compiles and runs JVM-only Kotlin shell tests without Gradle. |
| API integration | `.\scripts\run-tests.ps1 -Suite api -Build` | Starts Docker test services and runs the `api-tests` container. |
| Browser E2E | `.\scripts\run-e2e-tests.ps1 -Project all` | Starts PostgreSQL/backend/frontend, captures backend logs in `tests\e2e`, and runs Playwright. |
| E2E reports | Playwright reporters in `tests\e2e\playwright.config.ts` | Produces `playwright-report`, `results\junit.xml`, `results\results.json`, and `test-results`. |

## Prerequisites and Services

Band 8 must run from the repository root on a clean worktree after all dependent bands have merged.

Required local tools:

- PowerShell 7+ (`pwsh`) on Windows.
- .NET 10 SDK.
- Node.js 20+ and npm.
- Rust toolchain from `rust-toolchain.toml`, plus `wasm32-unknown-unknown`.
- Docker Desktop with Docker Compose.
- `wasm-bindgen` CLI version required by `scripts\build-rust-wasm.ps1`.
- `cargo-deny`, `cargo-audit`, and `cargo-vet` for Rust supply-chain checks.
- `cargo-ndk` and `uniffi-bindgen` versions required by `scripts\build-rust-android.ps1`.
- Kotlin compiler discoverable by `scripts\test-android-shell.ps1` through `-KotlinHome`, `KOTLIN_HOME`, `PATH`, or Android Studio.
- Playwright browsers installed by the matrix step below.

Service expectations:

- No long-lived dev server should already occupy ports `5000`, `5173`, or `8080`.
- `scripts\run-tests.ps1 -Suite api -Build` owns Docker test services and cleans them unless `-Keep` is passed.
- `scripts\run-e2e-tests.ps1 -Project all` owns PostgreSQL, backend, and frontend startup for the E2E lane and writes backend side logs to `tests\e2e\backend-output.txt` and `tests\e2e\backend-error-output.txt`.
- Do not run `.\scripts\run-tests.ps1 -Suite all` for final reporting; the matrix below keeps clusters separated so failures have deterministic artifacts.

## Output Capture Contract

Create the artifact directory once before executing the matrix:

```powershell
$RepoRoot = "G:\Github\.worktrees\mosaic-band7-validation-readiness"
$ArtifactRoot = Join-Path $RepoRoot "artifacts\validation\band8"
New-Item -ItemType Directory -Force -Path $ArtifactRoot | Out-Null
```

For every command in the matrix, capture all output to the listed primary artifact before filtering or summarizing:

```powershell
$RepoRoot = "G:\Github\.worktrees\mosaic-band7-validation-readiness"
$ArtifactRoot = Join-Path $RepoRoot "artifacts\validation\band8"
$Artifact = Join-Path $ArtifactRoot "07-crypto-test.txt"
Push-Location (Join-Path $RepoRoot "libs\crypto")
try {
    npm test *> $Artifact
    $ExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($ExitCode -ne 0) {
    Get-Content -LiteralPath $Artifact | Select-Object -Last 200
    exit $ExitCode
}
```

Rules:

1. Never pipe expensive commands directly into `Select-String`, `Select-Object`, `grep`, or any other filter.
2. Never write validation artifacts to temp locations. Use `artifacts\validation\band8\`.
3. Keep one primary text capture per matrix row. Retry artifacts append a suffix such as `-retry1.txt`.
4. Preserve secondary artifacts produced by tools until final triage is complete.
5. Record command exit codes in the Band 8 summary next to the artifact path.

## Ordered Final Validation Matrix

The helper `.\scripts\check-band8-validation-readiness.ps1` statically validates the command names, working directories, and primary capture artifact paths in this table without running the expensive commands.

<!-- BAND8_MATRIX_START -->
| Order | Lane | Working directory | Command | Primary capture artifact |
|-------|------|-------------------|---------|--------------------------|
| 00 | readiness | `.` | `.\scripts\check-band8-validation-readiness.ps1` | `artifacts\validation\band8\00-readiness-static.txt` |
| 01 | preflight | `.` | `git --no-pager status --short --branch` | `artifacts\validation\band8\01-git-status-start.txt` |
| 02 | backend | `.` | `dotnet restore .\Mosaic.slnx` | `artifacts\validation\band8\02-dotnet-restore.txt` |
| 03 | crypto | `libs\crypto` | `npm ci` | `artifacts\validation\band8\03-crypto-npm-ci.txt` |
| 04 | crypto | `libs\crypto` | `npm run build` | `artifacts\validation\band8\04-crypto-build.txt` |
| 05 | crypto | `libs\crypto` | `npm run typecheck` | `artifacts\validation\band8\05-crypto-typecheck.txt` |
| 06 | crypto | `libs\crypto` | `npm run lint` | `artifacts\validation\band8\06-crypto-lint.txt` |
| 07 | crypto | `libs\crypto` | `npm test` | `artifacts\validation\band8\07-crypto-test.txt` |
| 08 | crypto | `libs\crypto` | `npm run test:coverage` | `artifacts\validation\band8\08-crypto-coverage.txt` |
| 09 | rust | `.` | `cargo fetch --locked` | `artifacts\validation\band8\09-rust-fetch.txt` |
| 10 | rust | `.` | `.\scripts\rust-check.ps1` | `artifacts\validation\band8\10-rust-check.txt` |
| 11 | rust | `.` | `.\scripts\build-rust-wasm.ps1` | `artifacts\validation\band8\11-rust-wasm-build.txt` |
| 12 | backend | `.` | `dotnet build .\apps\backend\Mosaic.Backend\Mosaic.Backend.csproj --configuration Release --no-restore` | `artifacts\validation\band8\12-backend-build.txt` |
| 13 | backend | `.` | `dotnet test .\apps\backend\Mosaic.Backend.Tests\Mosaic.Backend.Tests.csproj --configuration Release --no-restore` | `artifacts\validation\band8\13-backend-test.txt` |
| 14 | web | `apps\web` | `npm ci` | `artifacts\validation\band8\14-web-npm-ci.txt` |
| 15 | web | `apps\web` | `npm run typecheck` | `artifacts\validation\band8\15-web-typecheck.txt` |
| 16 | web | `apps\web` | `npm run lint` | `artifacts\validation\band8\16-web-lint.txt` |
| 17 | web | `apps\web` | `npm run build` | `artifacts\validation\band8\17-web-build.txt` |
| 18 | web | `apps\web` | `npm run test:run` | `artifacts\validation\band8\18-web-test.txt` |
| 19 | android shell | `.` | `.\scripts\build-rust-android.ps1` | `artifacts\validation\band8\19-rust-android-build.txt` |
| 20 | android shell | `.` | `.\scripts\test-android-shell.ps1` | `artifacts\validation\band8\20-android-shell-test.txt` |
| 21 | integration | `tests\integration` | `npm ci` | `artifacts\validation\band8\21-integration-npm-ci.txt` |
| 22 | integration | `tests\integration` | `npm test` | `artifacts\validation\band8\22-integration-test.txt` |
| 23 | backend | `.` | `.\scripts\run-tests.ps1 -Suite api -Build` | `artifacts\validation\band8\23-api-integration.txt` |
| 24 | e2e | `tests\e2e` | `npm ci` | `artifacts\validation\band8\24-e2e-npm-ci.txt` |
| 25 | e2e | `tests\e2e` | `npx playwright install chromium` | `artifacts\validation\band8\25-playwright-install.txt` |
| 26 | e2e | `.` | `.\scripts\run-e2e-tests.ps1 -Project all` | `artifacts\validation\band8\26-e2e-project-all.txt` |
| 27 | final | `.` | `git --no-pager diff --check` | `artifacts\validation\band8\27-git-diff-check.txt` |
| 28 | final | `.` | `git --no-pager status --short` | `artifacts\validation\band8\28-git-status-final.txt` |
<!-- BAND8_MATRIX_END -->

## Expected Secondary Artifacts

| Producer | Secondary artifacts |
|----------|---------------------|
| Crypto coverage | `libs\crypto\coverage\` |
| Rust build/test | `target\` |
| Rust WASM build | `target\wasm-bindgen\mosaic-wasm\`; generated files under `apps\web\src\generated\mosaic-wasm\` |
| Rust Android build | `target\android\`; `target\release\mosaic_uniffi.dll` on Windows |
| Android shell tests | `apps\android-shell\build\test-classes\` |
| API integration | Docker test containers/volumes from `docker-compose.test.yml` |
| E2E runner | `tests\e2e\backend-output.txt`; `tests\e2e\backend-error-output.txt`; `tests\e2e\playwright-report\`; `tests\e2e\results\`; `tests\e2e\test-results\` |

If `git --no-pager status --short` reports source changes after generated-code steps, classify them before cleanup. Generated Rust WASM binding diffs are product-regression candidates unless a merged upstream band intentionally changed generated outputs without committing them.

## Triage Taxonomy

Use exactly one primary classification per failing cluster.

### Product regression

A deterministic failure caused by repository code, generated artifacts, tests, configuration, or documented behavior. Examples:

- compile, typecheck, lint, unit, integration, or E2E failure that reproduces on rerun;
- zero-knowledge or privacy invariant test failure;
- generated Rust/WASM artifacts differ from committed sources;
- Docker services start successfully but API or E2E behavior is wrong.

### Test flake

A non-deterministic test failure where the same command passes on a same-environment retry without code changes. Requirements:

- capture both the failing artifact and the retry artifact;
- note the test name, project, retry count, and whether Playwright/Vitest built-in retries were already used;
- continue only after the exact matrix row passes.

### Environment issue

A failure caused by local infrastructure rather than product code. Examples:

- missing SDK, CLI, browser, Kotlin compiler, Docker daemon, or cargo supply-chain tool;
- port collision on `5000`, `5173`, or `8080`;
- Docker health timeout before any product test executes;
- network/package-registry outage during install;
- insufficient disk space or permission failure.

Fix the environment, then rerun the same matrix row with a new artifact suffix.

### Known deferred non-blocker

A failure that is already documented, scoped, and approved as outside the v1 final gate. It must include:

- a specific spec, issue, or changelog reference;
- proof that the failure matches the known limitation exactly;
- explicit Band 8 summary entry naming the owner and reason.

Undocumented failures are not non-blockers.

## Fix-Forward Rerun Policy

Do not rerun the whole matrix immediately after a failure. Fix forward by cluster:

1. Preserve the failing artifact and classify the failure.
2. Apply the minimal fix in the owning workstream or wait for the owning band to merge.
3. Rerun the earliest failed row with a retry artifact.
4. Rerun all downstream rows whose inputs may have changed.
5. Continue the matrix only after the failed row and its dependent rows pass.

Dependency clusters:

| Failed cluster | Required reruns after fix |
|----------------|---------------------------|
| Preflight/readiness | Restart from row 00. |
| Backend restore/build/test | Rows 02, 12, 13, 23, 26, 27, 28. |
| Crypto library | Rows 03-08, 14-18, 26, 27, 28. |
| Rust core/check | Rows 09-11, 14-20, 26, 27, 28. |
| Rust WASM generation | Rows 11, 14-18, 26, 27, 28. |
| Web frontend | Rows 14-18, 26, 27, 28. |
| Android shell | Rows 19, 20, 27, 28. |
| Integration/API | Rows 21-23, 26, 27, 28. |
| E2E | Rows 24-28. |

For a suspected flake, allow one same-command retry before opening a fix-forward loop. A second failure in the same row is a product regression or environment issue until proven otherwise.

## Cleanup Rules

Keep artifacts until the Band 8 summary is complete. After results are archived, clean generated validation outputs only:

```powershell
Remove-Item -LiteralPath "artifacts\validation\band8" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "tests\e2e\backend-output.txt" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "tests\e2e\backend-error-output.txt" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "tests\e2e\playwright-report" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "tests\e2e\results" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "tests\e2e\test-results" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "libs\crypto\coverage" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "apps\android-shell\build" -Recurse -Force -ErrorAction SilentlyContinue
```

Do not delete source files, committed generated bindings, package locks, or other agents' changes. If cleanup leaves non-artifact changes in `git --no-pager status --short`, stop and triage before committing or reporting success.
