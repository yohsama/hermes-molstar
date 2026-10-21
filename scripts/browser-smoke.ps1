[CmdletBinding()]
param(
    [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputDir = Join-Path $root 'output/playwright/smoke'
$evidenceDir = Join-Path $root 'docs/evidence'
$scratchDir = Join-Path $root '.tmp/browser-smoke'
$browserCache = Join-Path $root '.cache/ms-playwright'
$npmCache = Join-Path $root '.cache/npm'
$localAppData = Join-Path $root '.cache/localappdata'
$session = "hermes-molstar-$PID"
$cliPackage = '@playwright/cli@0.1.22'
$server = $null

New-Item -ItemType Directory -Force -Path $outputDir, $evidenceDir, $scratchDir, $browserCache, $npmCache, $localAppData | Out-Null
$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npxCommand) { throw 'npx.cmd is required; install Node.js/npm before running the browser smoke' }
$env:npm_config_cache = $npmCache
$env:PLAYWRIGHT_BROWSERS_PATH = $browserCache
$env:LOCALAPPDATA = $localAppData
$env:HERMES_MOLSTAR_SMOKE_PORT = [string]$Port

function Invoke-PlaywrightJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $allArguments = @('--yes', '--package', $cliPackage, 'playwright-cli', "-s=$session", '--json') + $Arguments
    $text = (& npx.cmd @allArguments 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "playwright-cli failed ($LASTEXITCODE): $text"
    }
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json
}

function Find-FileButtonRef {
    param([Parameter(Mandatory)]$Snapshot)
    $rootNode = @($Snapshot.snapshot)[0]
    $button = @($rootNode.children) | Where-Object { $_.role -eq 'button' -and $_.name -eq 'Choose File' } | Select-Object -First 1
    if (-not $button.ref) { throw 'Could not find the file input in the fresh Playwright snapshot' }
    return [string]$button.ref
}

function Assert-StructureResult {
    param([Parameter(Mandatory)]$Result, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Format)
    if ($Result.name -ne $Name -or $Result.format -ne $Format -or
        $Result.atomCount -ne 327 -or $Result.modelCount -ne 1 -or
        $Result.structureCount -ne 1 -or $Result.canvasCount -ne 1) {
        throw "Unexpected $Format smoke result: $($Result | ConvertTo-Json -Compress)"
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

try {
    Push-Location $root
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

    $installedChromium = Get-ChildItem -LiteralPath $browserCache -Directory -Filter 'chromium-*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $installedChromium) {
        $installText = (& npx.cmd --yes --package $cliPackage playwright-cli --json install-browser chromium 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Chromium installation failed ($LASTEXITCODE): $installText" }
    }

    $serverOut = Join-Path $scratchDir 'server.stdout.log'
    $serverErr = Join-Path $scratchDir 'server.stderr.log'
    $server = Start-Process -FilePath node.exe `
        -ArgumentList @((Join-Path $root 'scripts/serve-browser-smoke.mjs')) `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

    $harnessUrl = "http://127.0.0.1:$Port/"
    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $harnessUrl -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $ready) { throw "Smoke server did not become ready at $harnessUrl" }

    Push-Location $outputDir
    Invoke-PlaywrightJson @('open', 'about:blank') | Out-Null
    Invoke-PlaywrightJson @('network-state-set', 'online') | Out-Null
    Invoke-PlaywrightJson @('goto', $harnessUrl) | Out-Null
    $snapshot = Invoke-PlaywrightJson @('snapshot')
    $fileRef = Find-FileButtonRef $snapshot
    Invoke-PlaywrightJson @('network-state-set', 'offline') | Out-Null

    Invoke-PlaywrightJson @('click', $fileRef) | Out-Null
    Invoke-PlaywrightJson @('upload', (Join-Path $root 'fixtures/1CRN.pdb')) | Out-Null
    $pdbProbe = Invoke-PlaywrightJson @(
        'run-code',
        "async page => { await page.waitForFunction(() => window.__molstarSmoke?.loads === 1, null, { timeout: 60000 }); return await page.evaluate(() => window.__molstarSmoke); }"
    )
    $pdbState = $pdbProbe.result | ConvertFrom-Json
    Assert-StructureResult $pdbState.last '1CRN.pdb' 'pdb'

    $snapshot = Invoke-PlaywrightJson @('snapshot')
    $fileRef = Find-FileButtonRef $snapshot
    Invoke-PlaywrightJson @('click', $fileRef) | Out-Null
    Invoke-PlaywrightJson @('upload', (Join-Path $root 'fixtures/1CRN.cif')) | Out-Null
    $finalProbe = Invoke-PlaywrightJson @(
        'run-code',
        "async page => { await page.waitForFunction(() => window.__molstarSmoke?.loads === 2, null, { timeout: 60000 }); const state=await page.evaluate(() => window.__molstarSmoke); const frame=page.frames().find(item => item !== page.mainFrame()); const canvas=await frame.locator('canvas').first().evaluate(node => ({width:node.width,height:node.height,clientWidth:node.clientWidth,clientHeight:node.clientHeight,webgl2:node.getContext('webgl2') instanceof WebGL2RenderingContext})); return {state,iframeCount:page.frames().length-1,canvas,browserVersion:page.context().browser().version(),userAgent:await page.evaluate(() => navigator.userAgent),online:await page.evaluate(() => navigator.onLine),httpResources:await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /^https?:/i.test(name)))}; }"
    )
    $final = $finalProbe.result | ConvertFrom-Json
    Assert-StructureResult $final.state.last '1CRN.cif' 'mmcif'
    if ($pdbState.viewerStartedOnline -ne $false -or $final.state.viewerStartedOnline -ne $false -or $final.online -ne $false) {
        throw 'Viewer did not start and remain in browser offline mode'
    }
    if ($final.iframeCount -ne 1 -or $final.canvas.webgl2 -ne $true -or
        $final.canvas.width -le 0 -or $final.canvas.height -le 0 -or
        $final.state.loads -ne 2 -or @($final.state.events | Where-Object { $_ -eq 'molstar.ready' }).Count -ne 1) {
        throw "Viewer reuse/WebGL assertion failed: $($final | ConvertTo-Json -Compress -Depth 8)"
    }
    if (@($final.httpResources).Count -ne 0) {
        throw "Unexpected HTTP(S) resource after harness navigation: $($final.httpResources -join ', ')"
    }

    $screenshotPath = Join-Path $outputDir 'molstar-offline-smoke.png'
    Invoke-PlaywrightJson @('screenshot', '--filename', $screenshotPath) | Out-Null
    $console = Invoke-PlaywrightJson @('console', 'error')
    if ($console.result -notmatch 'Errors:\s*0') {
        throw "Browser console contains errors: $($console.result)"
    }
    $requests = Invoke-PlaywrightJson @('requests', '--static')
    $desktopPluginPath = Join-Path $root 'dist/hermes-molstar/desktop/plugin.js'
    $viewerDocumentPath = Join-Path $root 'dist/hermes-molstar/dashboard/viewer-document.json'

    $evidence = [ordered]@{
        schema = 1
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        command = 'npm run test:browser'
        passed = $true
        playwrightCli = '0.1.22'
        browserVersion = $final.browserVersion
        userAgent = $final.userAgent
        offline = [ordered]@{
            setBeforeViewerStart = $true
            viewerStartedOnline = $final.state.viewerStartedOnline
            navigatorOnlineAtEnd = $final.online
            httpResourcesAfterHarnessNavigation = @($final.httpResources)
        }
        pdb = $pdbState.last
        mmcif = $final.state.last
        lifecycle = [ordered]@{
            loads = $final.state.loads
            events = @($final.state.events)
            iframeCount = $final.iframeCount
        }
        canvas = $final.canvas
        consoleErrors = 0
        requestLog = $requests.result
        fixtures = [ordered]@{
            pdbSha256 = Get-Sha256Hex (Join-Path $root 'fixtures/1CRN.pdb')
            mmcifSha256 = Get-Sha256Hex (Join-Path $root 'fixtures/1CRN.cif')
        }
        artifacts = [ordered]@{
            desktopPlugin = [ordered]@{
                path = 'dist/hermes-molstar/desktop/plugin.js'
                bytes = (Get-Item -LiteralPath $desktopPluginPath).Length
                sha256 = Get-Sha256Hex $desktopPluginPath
            }
            viewerDocument = [ordered]@{
                path = 'dist/hermes-molstar/dashboard/viewer-document.json'
                bytes = (Get-Item -LiteralPath $viewerDocumentPath).Length
                sha256 = Get-Sha256Hex $viewerDocumentPath
            }
        }
        screenshot = 'output/playwright/smoke/molstar-offline-smoke.png'
        scope = 'Chromium browser harness; not Hermes Electron'
    }
    $evidencePath = Join-Path $evidenceDir 'browser-smoke.json'
    [IO.File]::WriteAllText($evidencePath, (($evidence | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
    Write-Output ($evidence | ConvertTo-Json -Depth 10)
} finally {
    try { Invoke-PlaywrightJson @('close') | Out-Null } catch { }
    while ((Get-Location).Path -ne $root -and (Get-Location).Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        Pop-Location
    }
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id
        $server.WaitForExit()
    }
}
