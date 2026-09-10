# Self-contained Windows installer. Compatible with Windows PowerShell 5.1.
[CmdletBinding()]
param(
    [string]$Version = $env:LAOHUANG_VERSION,
    [string]$InstallDir = $env:LAOHUANG_INSTALL_DIR,
    [switch]$NoModifyPath
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on macOS/Linux.' }
if (!$InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'laohuang' }
if (![IO.Path]::IsPathRooted($InstallDir) -or $InstallDir -match '[\r\n;%"!]') {
    throw 'Installation directory must be absolute and cannot contain newline, semicolon, percent, quote or exclamation characters.'
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$base = 'https://github.com/hxr223/laoHuangCode/releases'
if ($env:LAOHUANG_DOWNLOAD_BASE) { $base = $env:LAOHUANG_DOWNLOAD_BASE.TrimEnd('/') }
if ($base -notmatch '^(https|file)://') { throw 'Download source must use HTTPS.' }
$architecture = $env:PROCESSOR_ARCHITEW6432
if (!$architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
switch ($architecture) {
    'AMD64' { $arch = 'x64' }
    'ARM64' { $arch = 'arm64' }
    default { throw "Unsupported architecture: $architecture" }
}
# Exclude the legacy WSL bash launcher, just as the CLI does.
$bashPaths = @()
foreach ($prefix in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($prefix) { $bashPaths += Join-Path $prefix 'Git\bin\bash.exe' }
}
$bashPaths += @(Get-Command bash.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
$bash = @($bashPaths | Where-Object { $_ -notmatch '\\Windows\\(System32|Sysnative)\\bash\.exe$' -and (Test-Path -LiteralPath $_ -PathType Leaf) })
if (!$bash.Count) { throw 'Bash not found. Install Git for Windows from https://git-scm.com/download/win, then rerun this installer.' }

function Download([string]$Url, [string]$Destination) {
    if ($Url.StartsWith('file://')) { Copy-Item -LiteralPath ([Uri]$Url).LocalPath -Destination $Destination; return }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 600
}
function Check-Version([string]$Value) {
    if ($Value -cnotmatch '\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z') { throw 'Invalid release version; expected X.Y.Z.' }
}
function Write-Utf8([string]$Path, [string]$Value) {
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}
$releases = Join-Path $InstallDir 'releases'
$bin = Join-Path $InstallDir 'bin'
[IO.Directory]::CreateDirectory($releases) | Out-Null
[IO.Directory]::CreateDirectory($bin) | Out-Null
$lockPath = Join-Path $InstallDir '.install-lock'
try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
catch { throw "Installation lock exists: $lockPath. Remove it only after confirming no installer is running." }
$stage = Join-Path $releases ('.install-' + [Guid]::NewGuid().ToString('N'))
try {
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    if (!$Version) {
        Download "$base/latest/download/version.txt" (Join-Path $stage 'version.txt')
        $Version = [IO.File]::ReadAllText((Join-Path $stage 'version.txt')).TrimEnd("`r", "`n")
    }
    Check-Version $Version
    $archive = "laohuang-$Version-win32-$arch.zip"
    Write-Host "Downloading laohuang $Version (win32-$arch)..."
    $zip = Join-Path $stage 'archive.zip'
    $checksum = Join-Path $stage 'checksum'
    Download "$base/download/v$Version/$archive.sha256" $checksum
    Download "$base/download/v$Version/$archive" $zip
    $expected = ([IO.File]::ReadAllText($checksum) -split '\s+')[0]
    if ($expected -notmatch '\A[a-fA-F0-9]{64}\z') { throw 'Invalid SHA-256 checksum.' }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ine $expected) { throw 'Download checksum mismatch; existing installation was not changed.' }
    $package = Join-Path $stage 'package'
    Expand-Archive -LiteralPath $zip -DestinationPath $package
    $node = Join-Path $package 'runtime\node.exe'
    $entry = Join-Path $package 'app\node_modules\laohuang\dist\bin.js'
    $actual = & $node $entry --version
    if ($LASTEXITCODE -ne 0 -or $actual -ne "laohuang $Version") { throw "Release failed startup verification: $actual" }

    $release = Join-Path $releases ($Version + '-' + [Guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $package -Destination $release
    $launcher = Join-Path $stage 'laohuang.cmd'
    # Keep paths relative, so CMD does not expand characters in the user's profile path.
    $releaseName = Split-Path $release -Leaf
    Write-Utf8 $launcher "@echo off`r`n@`"%~dp0..\releases\$releaseName\laohuang.cmd`" %*`r`n"
    $target = Join-Path $bin 'laohuang.cmd'
    $backup = Join-Path $bin 'laohuang.cmd.bak'
    if (!$NoModifyPath -and !$env:LAOHUANG_NO_MODIFY_PATH) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $parts = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $bin.TrimEnd('\') })
        [Environment]::SetEnvironmentVariable('Path', (@($bin) + $parts -join ';'), 'User')
        $env:Path = $bin + ';' + $env:Path
        Write-Host 'User PATH configured. Restart your terminal application to load the new PATH.'
    } else { Write-Host "PATH modification skipped. Add $bin to your PATH." }
    if (Test-Path -LiteralPath $target) { [IO.File]::Replace($launcher, $target, $backup) }
    else { [IO.File]::Move($launcher, $target) }
    Write-Host "Installed laohuang $Version to $target"
    $quotedBin = $bin.Replace("'", "''")
    Write-Host "In the current PowerShell terminal, run: `$env:Path = '$quotedBin;' + `$env:Path; laohuang"
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    foreach ($directory in ($machinePath -split ';' | Where-Object { $_ })) {
        foreach ($name in @('laohuang.exe', 'laohuang.cmd', 'laohuang.bat')) {
            $other = Join-Path ([Environment]::ExpandEnvironmentVariables($directory)) $name
            if (Test-Path -LiteralPath $other -PathType Leaf) { Write-Warning "System PATH contains another installation: $other. It may take precedence in new terminals." }
        }
    }
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    $lock.Dispose()
    Remove-Item -LiteralPath $lockPath
}
