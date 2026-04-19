# Pre-popula o cache do electron-builder com winCodeSign-2.6.0 extraido
# pulando os symlinks de macOS (libcrypto/libssl.dylib) que falham em Windows
# sem permissao para criar symbolic links. Roda antes de electron-builder.
#
# Idempotente: se o cache ja existe valido, sai sem fazer nada.

$ErrorActionPreference = 'Stop'

$Version    = '2.6.0'
$CacheRoot  = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
$TargetDir  = Join-Path $CacheRoot ("winCodeSign-{0}" -f $Version)
$Url        = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-{0}/winCodeSign-{0}.7z" -f $Version

# Marker para sabermos que extraimos com sucesso (mesmo pulando dylibs)
$Marker     = Join-Path $TargetDir '.prepared-no-symlinks'

if (Test-Path $Marker) {
    Write-Host "winCodeSign cache ja preparado em: $TargetDir"
    exit 0
}

# Localizar 7za do projeto (vem como dep transitiva do electron-builder)
$SevenZip = Join-Path $PSScriptRoot '..\node_modules\7zip-bin\win\x64\7za.exe'
if (-not (Test-Path $SevenZip)) {
    Write-Error "7za.exe nao encontrado em node_modules/7zip-bin. Rode 'pnpm install' primeiro."
    exit 1
}

if (-not (Test-Path $CacheRoot)) {
    New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
}

# Baixar archive em local temporario
$Tmp7z = Join-Path $env:TEMP ("winCodeSign-{0}.7z" -f $Version)
if (-not (Test-Path $Tmp7z)) {
    Write-Host "Baixando $Url ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $Tmp7z -UseBasicParsing
}

# Limpar destino se houver extracao anterior incompleta
if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
}
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

# Extrair excluindo os dois symlinks que exigem privilegio.
# Esses arquivos so sao usados quando se assina build pra macOS, irrelevantes em Windows.
Write-Host "Extraindo $Tmp7z para $TargetDir (sem symlinks darwin)..."
& $SevenZip x -bd -y `
    "-o$TargetDir" `
    "-xr!libcrypto.dylib" `
    "-xr!libssl.dylib" `
    $Tmp7z | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Error "7za retornou codigo $LASTEXITCODE durante extracao."
    exit $LASTEXITCODE
}

# Marcar como preparado para builds futuros pularem este script
New-Item -ItemType File -Path $Marker -Force | Out-Null
Write-Host "winCodeSign $Version preparado com sucesso (symlinks macOS pulados)."
