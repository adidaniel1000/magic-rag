# Second Mind per-user installer. Generated origin is configured by npm run release.
# Usage: powershell -c "irm https://YOUR-HOST/install.ps1 | iex"
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $InstallBase = '__SECOND_MIND_BASE_URL__'
  if ($InstallBase -like '__*') { throw 'This installer has not been configured. Run npm run release -- --base-url https://YOUR-HOST before deploying public/.' }
  if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Second Mind currently requires Windows x64.' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $InstallBase = $InstallBase.TrimEnd('/')
  $BaseUri = [Uri]$InstallBase
  if ($BaseUri.Scheme -ne 'https') { throw 'The setup host must use HTTPS.' }
  $AppRoot = Join-Path $env:LOCALAPPDATA 'SecondMind'
  New-Item -ItemType Directory -Path $AppRoot -Force | Out-Null
  $InstancePath = Join-Path $AppRoot 'instance.json'
  if (Test-Path -LiteralPath $InstancePath) {
    try {
      $RunningInstance = Get-Content -LiteralPath $InstancePath -Raw | ConvertFrom-Json
      if ([int]$RunningInstance.port -ge 1024 -and [int]$RunningInstance.port -le 65535) {
        $RunningHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + [int]$RunningInstance.port + '/health') -TimeoutSec 2
      }
    } catch { $RunningHealth = $null }
    if ($RunningHealth.service -eq 'secondmind') { throw 'Second Mind is running. Stop it with Ctrl+C or secondmind stop, then run this installer again.' }
  }
  Write-Host 'Second Mind - private knowledge for your AI tools' -ForegroundColor Green
  Write-Host 'Checking the release...'
  $Manifest = Invoke-RestMethod -Uri ($InstallBase + '/release.json')
  if ($Manifest.version -notmatch '^\d+\.\d+\.\d+$' -or $Manifest.nodeVersion -notmatch '^24\.\d+\.\d+$') { throw 'Invalid release manifest.' }
  if ($Manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $Manifest.package -notmatch '^releases/secondmind-local-\d+\.\d+\.\d+\.tgz$') { throw 'Invalid package metadata.' }
  $NodeExe = $null
  $DetectedNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($DetectedNode) {
    $DetectedVersion = & $DetectedNode.Source -p 'process.versions.node'
    if ($LASTEXITCODE -eq 0 -and $DetectedVersion -match '^24\.(\d+)\.' -and [int]$Matches[1] -ge 12) { $NodeExe = $DetectedNode.Source }
  }
  if (-not $NodeExe) {
    Write-Host 'Installing a private Node.js runtime (no administrator access needed)...'
    $NodeVersion = 'v' + $Manifest.nodeVersion
    $NodeArchive = 'node-' + $NodeVersion + '-win-x64.zip'
    $NodeUrl = 'https://nodejs.org/dist/' + $NodeVersion + '/'
    $RuntimeRoot = Join-Path $AppRoot 'runtime'
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    $ArchivePath = Join-Path $RuntimeRoot $NodeArchive
    $Sums = Invoke-WebRequest -UseBasicParsing -Uri ($NodeUrl + 'SHASUMS256.txt')
    $ExpectedNodeHash = $null
    foreach ($Line in ($Sums.Content -split "`n")) {
      if ($Line.Trim() -match ('^([a-fA-F0-9]{64})\s+' + [Regex]::Escape($NodeArchive) + '$')) { $ExpectedNodeHash = $Matches[1] }
    }
    if (-not $ExpectedNodeHash) { throw 'Node.js checksum is missing.' }
    Invoke-WebRequest -UseBasicParsing -Uri ($NodeUrl + $NodeArchive) -OutFile $ArchivePath
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash -ne $ExpectedNodeHash) { throw 'Node.js download checksum did not match.' }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $RuntimeRoot -Force
    Remove-Item -LiteralPath $ArchivePath -Force
    $NodeExe = Join-Path $RuntimeRoot ('node-' + $NodeVersion + '-win-x64\node.exe')
  }
  $NodeHome = Split-Path -Parent $NodeExe
  $NpmCmd = Join-Path $NodeHome 'npm.cmd'
  if (-not (Test-Path -LiteralPath $NpmCmd)) { throw 'The selected Node.js installation does not include npm. Install Node.js 24 with npm and retry.' }
  $env:PATH = $NodeHome + ';' + $env:PATH
  $Downloads = Join-Path $AppRoot 'downloads'
  New-Item -ItemType Directory -Path $Downloads -Force | Out-Null
  $PackageFile = Join-Path $Downloads ('secondmind-' + $Manifest.version + '-' + [Guid]::NewGuid().ToString('N') + '.tgz')
  Write-Host 'Downloading and checking Second Mind...'
  Invoke-WebRequest -UseBasicParsing -Uri ($InstallBase + '/' + $Manifest.package) -OutFile $PackageFile
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $PackageFile).Hash -ne $Manifest.sha256) { throw 'Second Mind download checksum did not match. Nothing was installed.' }
  $VersionRoot = Join-Path $AppRoot ('app\' + $Manifest.version)
  New-Item -ItemType Directory -Path $VersionRoot -Force | Out-Null
  Write-Host 'Installing dependencies. This may take a few minutes...'
  & $NpmCmd install --prefix $VersionRoot --no-audit --no-fund --omit=dev $PackageFile
  if ($LASTEXITCODE -ne 0) { throw 'Package installation failed. Your documents and existing index have not been changed.' }
  $EntryPoint = Join-Path $VersionRoot 'node_modules\secondmind-local\dist\cli.js'
  if (-not (Test-Path -LiteralPath $EntryPoint)) { throw 'The installed package is missing its entry point.' }
  $BinRoot = Join-Path $AppRoot 'bin'
  New-Item -ItemType Directory -Path $BinRoot -Force | Out-Null
  $Wrapper = '@echo off' + "`r`n" + '"' + $NodeExe.Replace('%','%%') + '" "' + $EntryPoint.Replace('%','%%') + '" %*' + "`r`n"
  [IO.File]::WriteAllText((Join-Path $BinRoot 'secondmind.cmd'), $Wrapper, [Text.Encoding]::Default)
  $UserPath = [string][Environment]::GetEnvironmentVariable('Path','User')
  if (($UserPath -split ';') -notcontains $BinRoot) { [Environment]::SetEnvironmentVariable('Path', ($UserPath.TrimEnd(';') + ';' + $BinRoot).TrimStart(';'), 'User') }
  $env:PATH = $BinRoot + ';' + $env:PATH
  Remove-Item -LiteralPath $PackageFile -Force
  Write-Host ''
  Write-Host 'Installed. Next time, run: secondmind' -ForegroundColor Green
  Write-Host 'Keep this terminal open while using Second Mind. Close it or press Ctrl+C to stop.'
  Write-Host 'The browser will guide you through folder selection and the first model download.'
  & $NodeExe $EntryPoint
}
