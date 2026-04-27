param(
    [string]$KotlinHome
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ModuleRoot = Join-Path $ProjectRoot "apps\android-shell"
$BuildRoot = Join-Path $ModuleRoot "build"
$ClassesDir = Join-Path $BuildRoot "test-classes"

function Resolve-KotlinCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName
    )

    if ($KotlinHome) {
        $candidate = Join-Path $KotlinHome "bin\$CommandName.bat"
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    if ($env:KOTLIN_HOME) {
        $candidate = Join-Path $env:KOTLIN_HOME "bin\$CommandName.bat"
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    $pathCommand = Get-Command "$CommandName.bat" -ErrorAction SilentlyContinue
    if ($pathCommand) {
        return $pathCommand.Source
    }

    $studioRoots = @(
        "$env:ProgramFiles\Android",
        "${env:ProgramFiles(x86)}\Android",
        "$env:LOCALAPPDATA\Programs"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    foreach ($root in $studioRoots) {
        $candidate = Get-ChildItem -LiteralPath $root -Recurse -File -Filter "$CommandName.bat" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like "*\plugins\Kotlin\kotlinc\bin\$CommandName.bat" } |
            Select-Object -First 1
        if ($candidate) {
            return $candidate.FullName
        }
    }

    throw "Unable to find $CommandName.bat. Pass -KotlinHome, set KOTLIN_HOME, or add the Kotlin compiler to PATH."
}

$kotlinc = Resolve-KotlinCommand -CommandName "kotlinc"
$kotlin = Resolve-KotlinCommand -CommandName "kotlin"
$KotlinCompilerHome = Split-Path -Parent (Split-Path -Parent $kotlinc)
$KotlinStdlib = Join-Path $KotlinCompilerHome "lib\kotlin-stdlib.jar"
if (-not (Test-Path -LiteralPath $KotlinStdlib)) {
    throw "Unable to find Kotlin stdlib at $KotlinStdlib"
}

if (Test-Path -LiteralPath $ClassesDir) {
    Remove-Item -LiteralPath $ClassesDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $ClassesDir | Out-Null

$sourceRoots = @(
    (Join-Path $ModuleRoot "src\main\kotlin"),
    (Join-Path $ModuleRoot "src\test\kotlin")
)

$sources = @(
    $sourceRoots |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -File -Filter "*.kt" } |
        Sort-Object FullName |
        ForEach-Object { $_.FullName }
)

if ($sources.Count -eq 0) {
    throw "No Kotlin sources found under $ModuleRoot"
}

Write-Host "==> Compiling Android shell Kotlin/JVM tests" -ForegroundColor Cyan
& $kotlinc @sources -classpath $KotlinStdlib -d $ClassesDir -jvm-target 17
if ($LASTEXITCODE -ne 0) {
    throw "Kotlin compilation failed with exit code $LASTEXITCODE"
}

Write-Host "==> Running Android shell foundation tests" -ForegroundColor Cyan
& $kotlin -classpath "$ClassesDir;$KotlinStdlib" "org.mosaic.android.foundation.AndroidShellFoundationTestKt"
if ($LASTEXITCODE -ne 0) {
    throw "Android shell tests failed with exit code $LASTEXITCODE"
}
