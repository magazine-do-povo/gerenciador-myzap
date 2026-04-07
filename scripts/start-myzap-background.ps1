param(
    [Parameter(Mandatory = $true)]
    [string]$MyZapDir,

    [string]$Command = 'npm run dev',

    [string]$WorkerScript = ''
)

$ErrorActionPreference = 'Stop'

function Test-LocalTcpPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,

        [int]$TimeoutMs = 750
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }

        $client.EndConnect($asyncResult) | Out-Null
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

$resolvedMyZapDir = [System.IO.Path]::GetFullPath($MyZapDir)
if (-not (Test-Path -LiteralPath $resolvedMyZapDir)) {
    throw "Diretorio do MyZap nao encontrado: $resolvedMyZapDir"
}

$packageJsonPath = Join-Path $resolvedMyZapDir 'package.json'
if (-not (Test-Path -LiteralPath $packageJsonPath)) {
    throw "package.json nao encontrado no diretorio do MyZap: $resolvedMyZapDir"
}

if ([string]::IsNullOrWhiteSpace($WorkerScript)) {
    $WorkerScript = Join-Path $PSScriptRoot 'run-myzap-dev-background.cmd'
}

$resolvedWorkerScript = [System.IO.Path]::GetFullPath($WorkerScript)
if (-not (Test-Path -LiteralPath $resolvedWorkerScript)) {
    throw "Script worker nao encontrado: $resolvedWorkerScript"
}

if (Test-LocalTcpPort -Port 5555) {
    exit 0
}

$escapedWorkerScript = $resolvedWorkerScript.Replace('"', '""')
$escapedMyZapDir = $resolvedMyZapDir.Replace('"', '""')
$escapedCommand = $Command.Replace('"', '""')

$argumentList = '/d /c ""{0}" "{1}" "{2}""' -f $escapedWorkerScript, $escapedMyZapDir, $escapedCommand
Start-Process -FilePath 'cmd.exe' -ArgumentList $argumentList -WindowStyle Hidden | Out-Null
