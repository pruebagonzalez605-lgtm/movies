param(
  [switch]$Permanent,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$bundledNodeDirectory = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
$bundledNode = Join-Path $bundledNodeDirectory "node.exe"

if (Test-Path -LiteralPath $bundledNode) {
  $env:Path = "$bundledNodeDirectory;$env:Path"
}

$nodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 22) {
  throw "Wrangler necesita Node 22 o superior. Instala Node 22 LTS y vuelve a ejecutar este script."
}

$arguments = @("wrangler", "deploy")
if (-not $Permanent) {
  $arguments += "--temporary"
}
if ($DryRun) {
  $arguments += "--dry-run"
}

& npx.cmd @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Wrangler no pudo completar el despliegue."
}
