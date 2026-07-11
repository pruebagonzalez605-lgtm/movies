param(
  [Parameter(Mandatory = $true)]
  [string]$InputVideo,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,

  [int]$IntervalSeconds = 10
)

$ErrorActionPreference = "Stop"
$resolvedInput = (Resolve-Path -LiteralPath $InputVideo).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path

$durationText = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $resolvedInput
if ($LASTEXITCODE -ne 0 -or -not $durationText) {
  throw "No se pudo leer la duracion. Verifica que ffprobe este instalado."
}

$duration = [Math]::Ceiling([double]::Parse($durationText, [Globalization.CultureInfo]::InvariantCulture))
$spritePattern = Join-Path $resolvedOutput "sprite-%03d.jpg"
$filter = "fps=1/$IntervalSeconds,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=5x5"

& ffmpeg -y -i $resolvedInput -vf $filter -q:v 5 -vsync 0 $spritePattern
if ($LASTEXITCODE -ne 0) {
  throw "No se pudieron generar las capturas. Verifica que ffmpeg este instalado."
}

function Format-VttTime([int]$Seconds) {
  $hours = [Math]::Floor($Seconds / 3600)
  $minutes = [Math]::Floor(($Seconds % 3600) / 60)
  $secs = $Seconds % 60
  return "{0:D2}:{1:D2}:{2:D2}.000" -f $hours, $minutes, $secs
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("WEBVTT")
$lines.Add("")
$frameCount = [Math]::Ceiling($duration / $IntervalSeconds)

for ($index = 0; $index -lt $frameCount; $index += 1) {
  $start = $index * $IntervalSeconds
  $end = [Math]::Min(($index + 1) * $IntervalSeconds, $duration)
  $sheet = [Math]::Floor($index / 25) + 1
  $position = $index % 25
  $x = ($position % 5) * 160
  $y = [Math]::Floor($position / 5) * 90
  $lines.Add("$(Format-VttTime $start) --> $(Format-VttTime $end)")
  $lines.Add(("sprite-{0:D3}.jpg#xywh={1},{2},160,90" -f $sheet, $x, $y))
  $lines.Add("")
}

$vttPath = Join-Path $resolvedOutput "thumbnails.vtt"
[IO.File]::WriteAllLines($vttPath, $lines, [Text.UTF8Encoding]::new($false))
Write-Host "Miniaturas creadas en $resolvedOutput"
Write-Host "Agrega al contenido: previewThumbnails: './ruta/thumbnails.vtt'"
