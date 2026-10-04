param(
  [Parameter(Mandatory=$true)][string]$CredentialSpecPath,
  [Parameter(Mandatory=$true)][string]$CommandSpecPath,
  [Parameter(Mandatory=$true)][string]$CandidateScriptPath,
  [Parameter(Mandatory=$true)][string]$StdoutPath,
  [Parameter(Mandatory=$true)][string]$StderrPath,
  [Parameter(Mandatory=$true)][string]$PidPath
)
$ErrorActionPreference = 'Stop'
$credSpec = Get-Content -LiteralPath $CredentialSpecPath -Raw | ConvertFrom-Json
$secure = ConvertTo-SecureString ([string]$credSpec.password) -AsPlainText -Force
$credential = [System.Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$($credSpec.username)", $secure)
$pwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
if (-not (Test-Path -LiteralPath $pwsh)) { throw 'PowerShell 7 is unavailable' }
# Windows paths cannot contain a double quote. Quoting these fixed file arguments is therefore unambiguous.
$argLine = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', ('"' + $CandidateScriptPath + '"'),
  ('"' + $CommandSpecPath + '"')
)
$p = Start-Process -FilePath $pwsh -ArgumentList $argLine -Credential $credential -UseNewEnvironment -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $PidPath -Value ([string]$p.Id) -NoNewline
$p.WaitForExit()
exit [int]$p.ExitCode
