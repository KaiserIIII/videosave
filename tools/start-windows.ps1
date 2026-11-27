param([switch]$SetupOnly, [switch]$SkipPlatform, [switch]$McpConfig, [switch]$SharedQueue, [string]$McpClient)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$projectTools = Join-Path $project '.local-tools'
$tools = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'VideoSave/tools' } else { $projectTools }
if ($McpClient -and (!$SharedQueue -or $McpClient -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')) { throw 'Use a registered -McpClient with -SharedQueue.' }
if ($SharedQueue -and -not $McpConfig) { throw 'Use -SharedQueue with -McpConfig.' }
if ($SharedQueue) {
    if ($env:MEDIA_TOOLKIT_TOKEN) { throw 'Use the manual MCP configuration when the companion uses a custom pairing code.' }
    $sharedPort = if ($env:PORT) { $env:PORT } else { '8765' }
    if ($sharedPort -notmatch '^\d{1,5}$' -or [int]$sharedPort -lt 1 -or [int]$sharedPort -gt 65535) {
        throw 'A shared queue needs a fixed PORT between 1 and 65535.'
    }
}

function Find-Application([string]$name) {
    (Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
}

function Find-PortablePackage([hashtable]$package) {
    foreach ($root in @($projectTools, $tools)) {
        $directory = Join-Path $root $package.folder
        if (@($package.files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $directory $_) -PathType Leaf) }).Count -eq 0) {
            return $directory
        }
    }
}

function Install-Portable([hashtable]$package) {
    $available = Find-PortablePackage $package
    if ($available) { return $available }
    $installed = Join-Path $tools $package.folder
    $files = @($package.files | ForEach-Object { Join-Path $installed $_ })
    if ([Environment]::Is64BitOperatingSystem -eq $false -or
        ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64')) {
        throw "The portable $($package.name) package requires Windows x64. Install it for your system and add it to PATH."
    }
    if (Test-Path -LiteralPath $installed) {
        throw "Incomplete $($package.name) installation at $installed. Move that directory aside and retry."
    }
    $staging = Join-Path $tools ('setup-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($staging) | Out-Null
    try {
        $archive = Join-Path $staging $package.asset
        [Console]::Error.WriteLine("Downloading $($package.name) $($package.version)...")
        & curl.exe --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 240 --output $archive $package.url
        if ($LASTEXITCODE -ne 0) { throw "Could not download $($package.name). Check your connection and retry." }
        $hasher = [Security.Cryptography.SHA256]::Create()
        $archiveStream = [IO.File]::OpenRead($archive)
        try {
            $digest = [BitConverter]::ToString($hasher.ComputeHash($archiveStream)).Replace('-', '')
        } finally {
            $archiveStream.Dispose()
            $hasher.Dispose()
        }
        if ($digest -ne $package.sha256) {
            throw "SHA-256 check failed for $($package.name)."
        }
        & tar.exe -xf $archive -C $staging
        if ($LASTEXITCODE -ne 0) { throw "Could not extract the verified $($package.name) archive." }
        $extracted = Join-Path $staging $package.folder
        foreach ($relative in $package.files) {
            if (-not (Test-Path -LiteralPath (Join-Path $extracted $relative) -PathType Leaf)) {
                throw "The $($package.name) archive is missing $relative."
            }
        }
        $record = $package.Clone()
        $record.installedAt = [DateTime]::UtcNow.ToString('o')
        $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $extracted 'videosave-install.json') -Encoding UTF8
        try {
            [IO.Directory]::Move($extracted, $installed)
        } catch [IO.IOException] {
            if (@($files | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count) { throw }
        }
    } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
    return $installed
}

$nodePackage = @{
    name = 'Node.js'; version = '24.22.3'; folder = 'node-v24.22.3-win-x64'; files = @('node.exe')
    source = 'https://github.com/nodejs/node'; commit = 'e63cab040c09d43ceef8cb35508c40044614e906'
    license = 'MIT and bundled dependency licenses in LICENSE'
    asset = 'node-v24.22.3-win-x64.7z'
    url = 'https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.7z'
    sha256 = 'e15e37b60cca7eeadad76e52515a19729c91fe7f4ed3dc3299ac66ce9dc940f7'
}
$ffmpegPackage = @{
    name = 'FFmpeg'; version = '8.1.2'; folder = 'ffmpeg-8.1.2-essentials_build'
    files = @('bin/ffmpeg.exe', 'bin/ffprobe.exe')
    source = 'https://github.com/FFmpeg/FFmpeg'; commit = '38b88335f99e76ed89ff3c93f877fdefce736c13'
    distributor = 'https://github.com/GyanD/codexffmpeg'; distributorCommit = '46465995c991fe65c5de853fa79bddec09cd6c37'
    license = 'GPL-3.0-or-later (essentials build)'
    asset = 'ffmpeg-8.1.2-essentials_build.7z'
    url = 'https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.7z'
    sha256 = 'e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6'
}

$node = Find-Application 'node.exe'
$major = if ($node) { & $node -p 'parseInt(process.versions.node, 10)' }
$needsProxy = ($env:HTTP_PROXY -or $env:HTTPS_PROXY) -and $env:NODE_USE_ENV_PROXY -ne '0'
$proxySupported = if ($node -and $needsProxy) {
    (& $node -p 'typeof require(process.argv[1]).setGlobalProxyFromEnv' 'node:http') -eq 'function'
}
if ($major -notmatch '^\d+$' -or [int]$major -lt 24 -or ($needsProxy -and -not $proxySupported)) {
    $node = Join-Path (Install-Portable $nodePackage) 'node.exe'
}

$mcpEnvironment = [ordered]@{}
$ffmpegDirectory = Find-PortablePackage $ffmpegPackage
foreach ($entry in @(@('FFMPEG_BIN', 'ffmpeg'), @('FFPROBE_BIN', 'ffprobe'))) {
    $variable, $name = $entry
    $override = [Environment]::GetEnvironmentVariable($variable)
    if ($override) {
        $executable = Find-Application $override
        if (-not $executable) { throw "$variable does not point to an executable." }
    } elseif ($ffmpegDirectory) {
        $executable = Join-Path $ffmpegDirectory "bin/$name.exe"
    } else {
        $executable = Find-Application "$name.exe"
        if (-not $executable) {
            $ffmpegDirectory = Install-Portable $ffmpegPackage
            $executable = Join-Path $ffmpegDirectory "bin/$name.exe"
        }
    }
    $mcpEnvironment[$variable] = $executable
}

if (-not $SkipPlatform -and -not $env:YTDLP_BIN -and $env:PROCESSOR_ARCHITECTURE -eq 'AMD64') {
    $extractorJson = & $node (Join-Path $PSScriptRoot 'setup-platform-downloads.mjs') "--cache-dir=$tools"
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path -LiteralPath (Join-Path $projectTools 'yt-dlp.exe')) {
            throw 'Could not verify the yt-dlp installation. Check the setup error or set YTDLP_BIN to a verified executable.'
        }
        [Console]::Error.WriteLine('Platform downloads are unavailable. VideoSave can still download direct media and streams. Run setup again to enable Bilibili and YouTube.')
    } else {
        $extractor = (ConvertFrom-Json -InputObject $extractorJson).path
        if (-not $extractor -or -not (Test-Path -LiteralPath $extractor -PathType Leaf)) { throw 'Could not locate the verified yt-dlp.' }
        $mcpEnvironment['YTDLP_BIN'] = $extractor
    }
}
if ($McpConfig) {
    if ($env:YTDLP_BIN) {
        $extractor = Find-Application $env:YTDLP_BIN
        if (-not $extractor) { throw 'YTDLP_BIN does not point to an executable.' }
        $mcpEnvironment['YTDLP_BIN'] = $extractor
    }
    if ($SharedQueue) {
        $mcpEnvironment['MEDIA_TOOLKIT_URL'] = "http://127.0.0.1:$([int]$sharedPort)"
        $mcpEnvironment['MEDIA_TOOLKIT_LOCAL_PAIRING'] = '1'
        if ($env:MEDIA_TOOLKIT_SETTINGS) {
            $mcpEnvironment['MEDIA_TOOLKIT_SETTINGS'] = [IO.Path]::GetFullPath($env:MEDIA_TOOLKIT_SETTINGS)
        }
    }
    if ($McpClient) { $mcpEnvironment['MEDIA_TOOLKIT_MCP_CLIENT'] = $McpClient }
    $config = @{mcpServers = @{videosave = [ordered]@{
        command = $node
        args = @((Join-Path $PSScriptRoot 'mcp-server.mjs'))
        env = $mcpEnvironment
    }}}
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::WriteLine((ConvertTo-Json -InputObject $config -Depth 6))
} elseif ($SetupOnly) {
    Write-Host "VideoSave tools are ready. MCP Node executable: $node"
} else {
    foreach ($variable in $mcpEnvironment.Keys) { [Environment]::SetEnvironmentVariable($variable, $mcpEnvironment[$variable]) }
    $env:MEDIA_TOOLKIT_LOCAL_PAIRING = '1'
    & $node (Join-Path $PSScriptRoot 'server.mjs')
    exit $LASTEXITCODE
}
