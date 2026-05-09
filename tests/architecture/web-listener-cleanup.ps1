$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$src = Join-Path $root 'apps\web\src'
$violations = New-Object System.Collections.Generic.List[string]

$AllowList = @{
  # App-lifetime global diagnostics handlers are registered once at startup and intentionally live until page unload.
  'apps/web/src/main.tsx' = 'App-lifetime global error/unhandledrejection diagnostics handlers live until page unload.'
  # SessionManager owns a singleton BroadcastChannel; logout closes the channel, and activity listeners already remove themselves.
  'apps/web/src/lib/session.ts' = 'Singleton session lifecycle owns BroadcastChannel; logout closes it and activity listeners have explicit cleanup.'
}

function ConvertTo-RepoPath([string]$Path) {
  return [System.IO.Path]::GetRelativePath($root, $Path).Replace('\', '/')
}

Get-ChildItem -Path $src -Recurse -Include *.ts,*.tsx |
  Where-Object {
    $_.FullName -notmatch '\\__tests__\\' -and
    $_.FullName -notmatch '\\service-worker\\' -and
    -not $AllowList.ContainsKey((ConvertTo-RepoPath $_.FullName))
  } |
  ForEach-Object {
    $text = Get-Content -Raw -Path $_.FullName
    if ($text -notmatch 'addEventListener') { return }

    $lines = Get-Content -Path $_.FullName
    for ($i = 0; $i -lt $lines.Count; $i++) {
      $line = $lines[$i]
      if ($line -notmatch 'addEventListener') { continue }
      if ($line -match 'once\s*:\s*true') { continue }
      if ($line -match 'serviceWorker|self\.addEventListener') { continue }

      $contextStart = [Math]::Max(0, $i - 30)
      $contextBefore = ($lines[$contextStart..$i] -join "`n")
      if ($contextBefore -notmatch 'useEffect\s*\(' -and $contextBefore -notmatch 'class\s+\w+') { continue }

      $start = [Math]::Max(0, $i - 20)
      $end = [Math]::Min($lines.Count - 1, $i + 40)
      $window = ($lines[$start..$end] -join "`n")
      if ($window -notmatch 'removeEventListener') {
        $relative = Resolve-Path -Relative $_.FullName
        $violations.Add("${relative}:$($i + 1) addEventListener lacks nearby removeEventListener cleanup")
      }
    }
  }

if ($violations.Count -gt 0) {
  Write-Host ("Listener cleanup guard failed:`n" + ($violations -join "`n")) -ForegroundColor Red
  exit 1
}

Write-Host "Listener cleanup guard passed."
