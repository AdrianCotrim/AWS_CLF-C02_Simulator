$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'
$frontendUrl = 'http://localhost:8000'
$apiUrl = 'http://localhost:3000/api/questions'

function Test-ApiRunning {
  try {
    $questions = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 2
    return $questions -is [System.Array]
  } catch {
    return $false
  }
}

function Test-FrontendRunning {
  try {
    $page = Invoke-WebRequest -Uri $frontendUrl -UseBasicParsing -TimeoutSec 2
    return $page.StatusCode -eq 200 -and $page.Content.Contains('data-view="add"')
  } catch {
    return $false
  }
}

if (-not (Test-ApiRunning)) {
  if (-not (Test-Path (Join-Path $backend 'node_modules\express'))) {
    Push-Location $backend
    try {
      npm install
      if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar as dependências do backend.' }
    } finally {
      Pop-Location
    }
  }
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-NoProfile', '-Command', 'npm run server') -WorkingDirectory $backend
  Write-Host 'API started at http://localhost:3000'
} else {
  Write-Host 'API already running at http://localhost:3000'
}

if (-not (Test-FrontendRunning)) {
  $python = Get-Command python -ErrorAction SilentlyContinue
  $pythonArgs = @('-m', 'http.server', '8000')
  if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
    $pythonArgs = @('-3', '-m', 'http.server', '8000')
  }
  if (-not $python) { throw 'Python was not found. Install Python or start the frontend manually.' }
  Start-Process -FilePath $python.Source -ArgumentList $pythonArgs -WorkingDirectory $root
  Write-Host 'Frontend started at http://localhost:8000'
} else {
  Write-Host 'Frontend already running at http://localhost:8000'
}

$bravePaths = @(
  (Join-Path $env:ProgramFiles 'BraveSoftware\Brave-Browser\Application\brave.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe'),
  (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe')
)
$brave = $bravePaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($brave) {
  Start-Process -FilePath $brave -ArgumentList $frontendUrl
} else {
  Start-Process $frontendUrl
}

Write-Host 'Open Add Question in the app. Close the server windows to stop the services.'