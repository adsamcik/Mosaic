# Thin wrapper around scripts/regenerate-test-vectors.mjs for Windows.
# See the .mjs file for full documentation.
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $ScriptDir 'regenerate-test-vectors.mjs') @args
exit $LASTEXITCODE
