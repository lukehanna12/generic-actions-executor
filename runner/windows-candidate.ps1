param(
  [Parameter(Mandatory=$true)][string]$SpecPath
)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json
if (-not $spec.argv -or $spec.argv.Count -lt 1) { throw 'candidate argv is invalid' }
if (-not $spec.cwd) { throw 'candidate cwd is invalid' }

Get-ChildItem Env: | ForEach-Object {
  Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue
}
foreach ($property in $spec.env.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable([string]$property.Name, [string]$property.Value, 'Process')
}
Set-Location -LiteralPath ([string]$spec.cwd)
$exe = [string]$spec.argv[0]
$argsList = @()
if ($spec.argv.Count -gt 1) {
  $argsList = @($spec.argv | Select-Object -Skip 1 | ForEach-Object { [string]$_ })
}
& $exe @argsList
if ($null -ne $LASTEXITCODE) { exit [int]$LASTEXITCODE }
if ($?) { exit 0 }
exit 1
