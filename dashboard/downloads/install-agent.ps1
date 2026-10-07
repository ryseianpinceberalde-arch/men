param(
    [Parameter(Mandatory = $true)][uri]$PackageManifestUrl,
    [Parameter(Mandatory = $true)][string]$SupabaseUrl,
    [Parameter(Mandatory = $true)][string]$PublishableKey,
    [Parameter(Mandatory = $true)][string]$DeviceId,
    [Parameter(Mandatory = $true)][string]$PairingCode
)

$ErrorActionPreference = "Stop"
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = [System.Security.Principal.WindowsPrincipal]::new($currentIdentity)
if (-not $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Open PowerShell as administrator, then run the setup command again."
}

$manifestUri = [uri]$PackageManifestUrl
if ($manifestUri.Scheme -ne "https" -and -not ($manifestUri.Scheme -eq "http" -and $manifestUri.IsLoopback)) {
    throw "The agent download must use HTTPS (HTTP is allowed only on localhost)."
}
$agentDirectory = Join-Path $env:ProgramFiles "PCMaintenance.Agent"
$agentExecutable = Join-Path $agentDirectory "PCMaintenance.Agent.exe"
$serviceName = "PCMaintenanceAgent"
$wasServiceRunning = $false

    $manifest = Invoke-RestMethod -UseBasicParsing -Uri $manifestUri.AbsoluteUri
    $archiveHash = [string]$manifest.sha256
    $packageParts = @($manifest.parts)
    if ($archiveHash -notmatch "^[a-f0-9]{64}$" -or $packageParts.Count -lt 1) {
        throw "The agent download manifest is invalid. Update the dashboard deployment and try again."
    }

    $downloadDirectory = Join-Path $env:TEMP ("PCMaintenance.Agent-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $downloadDirectory | Out-Null
    $archivePath = Join-Path $downloadDirectory "agent.zip"
    $archiveStream = $null

    try {
        try {
            $archiveStream = [System.IO.File]::Create($archivePath)
            foreach ($partName in $packageParts) {
                if ([System.IO.Path]::GetFileName([string]$partName) -ne [string]$partName) {
                    throw "The agent download manifest contains an invalid file name."
                }

                $partUri = [uri]::new($manifestUri, [string]$partName)
                if ($partUri.Scheme -ne $manifestUri.Scheme -or $partUri.Host -ne $manifestUri.Host) {
                    throw "Agent package files must come from the same site."
                }

                $partPath = Join-Path $downloadDirectory ([System.IO.Path]::GetFileName($partUri.AbsolutePath))
                Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $partUri.AbsoluteUri -OutFile $partPath
                $partBytes = [System.IO.File]::ReadAllBytes($partPath)
                $archiveStream.Write($partBytes, 0, $partBytes.Length)
            }
        }
        finally {
            if ($null -ne $archiveStream) { $archiveStream.Dispose() }
        }

        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $archiveHash) { throw "The agent download failed its integrity check. Please try again." }

        $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
        $wasServiceRunning = $null -ne $service -and $service.Status -eq "Running"
        if ($wasServiceRunning) {
            Stop-Service -Name $serviceName -Force
            (Get-Service -Name $serviceName).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
        }

        New-Item -ItemType Directory -Path $agentDirectory -Force | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $agentDirectory -Force
        & $agentExecutable --supabase-url $SupabaseUrl --publishable-key $PublishableKey --device-id $DeviceId --pairing-code $PairingCode
        if ($LASTEXITCODE -ne 0) { throw "Pairing failed. Generate a fresh setup command in the dashboard and try again." }
    }
    finally {
        try {
            if ($wasServiceRunning) {
                $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
                if ($service -and $service.Status -ne "Running") { Start-Service -Name $serviceName }
            }
        }
        finally {
            $resolvedTempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
            $resolvedDownloadDirectory = [System.IO.Path]::GetFullPath($downloadDirectory)
            if ($resolvedDownloadDirectory.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedDownloadDirectory) -match '^PCMaintenance\.Agent-[a-f0-9]{32}$') {
                Remove-Item -LiteralPath $resolvedDownloadDirectory -Recurse -Force
            }
        }
    }

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $service) {
    $serviceControl = Join-Path $env:SystemRoot "System32\sc.exe"
    $binaryPath = '"{0}"' -f $agentExecutable
    $serviceCreationOutput = & $serviceControl create $serviceName "binPath=" $binaryPath "start=" "auto" "DisplayName=" "PC Maintenance Agent" 2>&1
    if ($LASTEXITCODE -ne 0) {
        $serviceCreationDetails = ($serviceCreationOutput | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ }) -join " "
        throw "Windows could not register the PC Maintenance Agent service (sc.exe exit code $LASTEXITCODE). $serviceCreationDetails"
    }
    $service = Get-Service -Name $serviceName
}
if ($service.Status -ne "Running") { Start-Service -Name $serviceName }

Get-Service -Name $serviceName
Write-Host "Setup complete. The PC Maintenance Agent service is installed and running."
