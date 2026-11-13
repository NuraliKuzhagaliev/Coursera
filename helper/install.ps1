[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidatePattern('^[a-p]{32}$')] [string] $ExtensionId,
    [string] $Downloads = (Join-Path $env:USERPROFILE 'Downloads'),
    [string] $Python,
    [string] $Chrome,
    [ValidatePattern('^org\.coursera_queue\.files(?:_test_[a-f0-9]{12})?$')] [string] $HostName = 'org.coursera_queue.files'
)
$ErrorActionPreference = 'Stop'
if (-not $Python) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) { $Python = & $launcher.Source -3 -c 'import sys; print(sys.executable)' }
    else { $Python = & python -c 'import sys; print(sys.executable)' }
    if ($LASTEXITCODE) { throw 'Python 3.10+ is required.' }
}
$Python = (Resolve-Path -LiteralPath $Python).ProviderPath
& $Python -E -s -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
if ($LASTEXITCODE) { throw 'Python 3.10+ is required.' }
if ($Chrome) { $Chrome = (Resolve-Path -LiteralPath $Chrome).ProviderPath }
if ($Python.Contains('%')) { throw 'Python path may not contain a percent sign.' }

$install = Join-Path $PSScriptRoot '.native'
$root = (Resolve-Path -LiteralPath $Downloads).ProviderPath
$work = Join-Path $root 'CourseraQueue'
New-Item -ItemType Directory -Force -Path $install,$work | Out-Null
if ((Get-Item -LiteralPath $work -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'CourseraQueue must be an ordinary directory.'
}
$work = & $Python -E -s -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve(strict=True))' $work
if ($LASTEXITCODE) { throw 'Unable to resolve the download directory.' }

$origin = "chrome-extension://$ExtensionId"
$manifestPath = Join-Path $install "$HostName.json"
$launcherPath = Join-Path $install 'launch.cmd'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($launcherPath, ('@chcp 65001 >nul' + "`r`n" +
    ('@"{0}" -E -s -B "%~dp0..\native_host.py" "%~1" "%~dp0config.json"' -f $Python) + "`r`n"), $utf8)
[IO.File]::WriteAllText((Join-Path $install 'config.json'), (@{
    origin = $origin; workdir = $work; chrome = $Chrome
} | ConvertTo-Json -Compress), $utf8)
[IO.File]::WriteAllText($manifestPath, (@{
    name = $HostName; description = 'Coursera Queue file helper'; type = 'stdio';
    path = $launcherPath; allowed_origins = @("$origin/")
} | ConvertTo-Json -Compress), $utf8)

$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath
Write-Output "Registered $HostName for $ExtensionId"
Write-Output "Download workspace: $work"
