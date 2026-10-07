param(
    [string]$DotnetPath = "dotnet",
    [string]$PublishedAgentDirectory = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $repoRoot "agent\PCMaintenance.Agent\PCMaintenance.Agent.csproj"
$setupSourcePath = Join-Path $repoRoot "agent\PCMaintenance.Agent.Setup\Program.cs"
$downloadDirectory = Join-Path $repoRoot "dashboard\downloads"
$buildDirectory = Join-Path $env:TEMP ("pcma-agent-package-" + [guid]::NewGuid().ToString("N"))
$publishDirectory = Join-Path $buildDirectory "publish"
$archivePath = Join-Path $buildDirectory "PCMaintenance.Agent-win-x64.zip"

New-Item -ItemType Directory -Path $publishDirectory, $downloadDirectory -Force | Out-Null

try {
    if ([string]::IsNullOrWhiteSpace($PublishedAgentDirectory)) {
        & $DotnetPath publish $projectPath -c Release -r win-x64 --self-contained true -o $publishDirectory
        if ($LASTEXITCODE -ne 0) { throw "The Windows agent publish failed with exit code $LASTEXITCODE." }
        $agentOutputDirectory = $publishDirectory
    }
    else {
        $agentOutputDirectory = (Resolve-Path -LiteralPath $PublishedAgentDirectory -ErrorAction Stop).ProviderPath
        if (-not (Test-Path -LiteralPath (Join-Path $agentOutputDirectory "PCMaintenance.Agent.exe"))) {
            throw "The published agent directory does not contain PCMaintenance.Agent.exe."
        }
    }

    Compress-Archive -Path (Join-Path $agentOutputDirectory "*") -DestinationPath $archivePath -CompressionLevel Optimal
    $archiveBytes = [System.IO.File]::ReadAllBytes($archivePath)
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $chunkSize = 15MB
    $packageName = "PCMaintenance.Agent-win-x64-$($archiveHash.Substring(0, 12)).zip"
    $parts = [System.Collections.Generic.List[string]]::new()

    for ($offset = 0; $offset -lt $archiveBytes.Length; $offset += $chunkSize) {
        $partNumber = $parts.Count + 1
        $partName = "{0}.part{1:D3}" -f $packageName, $partNumber
        $length = [Math]::Min($chunkSize, $archiveBytes.Length - $offset)
        $partBytes = New-Object byte[] $length
        [Array]::Copy($archiveBytes, $offset, $partBytes, 0, $length)
        [System.IO.File]::WriteAllBytes((Join-Path $downloadDirectory $partName), $partBytes)
        $parts.Add($partName)
    }

    $manifest = [ordered]@{ sha256 = $archiveHash; parts = @($parts) }
    $manifestJson = $manifest | ConvertTo-Json -Depth 3
    [System.IO.File]::WriteAllText(
        (Join-Path $downloadDirectory "agent-package.json"),
        $manifestJson,
        [System.Text.UTF8Encoding]::new($false)
    )

    $compilerCandidates = @(
        (Join-Path $env:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:SystemRoot "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )
    $csharpCompiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $csharpCompiler) { throw "The .NET Framework C# compiler (csc.exe) is required to build the native setup program." }

    $setupExecutable = Join-Path $downloadDirectory "PCMaintenance.Agent.Setup.exe"
    $frameworkDirectory = Split-Path -Parent $csharpCompiler
    $setupCompilerArguments = @(
        "/nologo",
        "/target:exe",
        "/platform:x64",
        "/out:$setupExecutable",
        "/reference:$(Join-Path $frameworkDirectory 'System.Web.Extensions.dll')",
        "/reference:$(Join-Path $frameworkDirectory 'System.IO.Compression.dll')",
        "/reference:$(Join-Path $frameworkDirectory 'System.ServiceProcess.dll')",
        $setupSourcePath
    )
    & $csharpCompiler @setupCompilerArguments
    if ($LASTEXITCODE -ne 0) { throw "The native setup program build failed with exit code $LASTEXITCODE." }

    Write-Host "Created the Windows agent package and native setup program with $($parts.Count) Cloudflare-compatible package files."
    Write-Host "Package parts, manifest, and setup program: $downloadDirectory"
}
finally {
    if (Test-Path -LiteralPath $buildDirectory) {
        $resolvedTempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        $resolvedBuildDirectory = [System.IO.Path]::GetFullPath($buildDirectory)
        if (-not $resolvedBuildDirectory.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedBuildDirectory) -notmatch '^pcma-agent-package-[a-f0-9]{32}$') {
            throw "Refusing to remove a temporary path outside this script's package folder."
        }
        Remove-Item -LiteralPath $resolvedBuildDirectory -Recurse -Force
    }
}
