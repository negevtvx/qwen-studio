# Qwen Studio installer. Double-click Install.bat, or:
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Vram 12
param(
  [ValidateSet('12', '16', '24')]
  [string]$Vram,
  [string]$ComfyRoot,
  [int]$Port = 0,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($msg) { Write-Host ""; Write-Host "== $msg" }

function Have-Cmd($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Get-File($url, $dest, $minBytes) {
  $name = Split-Path $dest -Leaf
  if ((Test-Path $dest) -and (Get-Item $dest).Length -ge $minBytes) {
    Write-Host "  have $name"
    return
  }
  Write-Host "  downloading $name"
  $dir = Split-Path $dest -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  & curl.exe -L --fail --retry 12 --retry-delay 3 --retry-all-errors -C - -o $dest $url
  if ($LASTEXITCODE -ne 0 -and -not ((Test-Path $dest) -and (Get-Item $dest).Length -ge $minBytes)) {
    throw "Download failed: $name"
  }
  Write-Host "  ok $name"
}

Say "Node.js"
if (-not (Have-Cmd 'node')) {
  Write-Host "Node.js 22+ is not installed. Trying winget..."
  if (-not (Have-Cmd 'winget')) { throw "Install Node.js 22 or newer from https://nodejs.org and run Install.bat again." }
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  throw "Node.js was installed. Close this window and double-click Install.bat again so the new PATH is picked up."
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { throw "Node.js $major is installed. Qwen Studio needs Node 22 or newer: https://nodejs.org" }
Write-Host "  Node $major"

if (-not $Vram) {
  Say "Graphics card"
  Write-Host "  How much VRAM do you have?"
  Write-Host "    12   smaller Q4 models, about 10 GB to download, happiest at 1024"
  Write-Host "    16   Q5 models, about 13 GB to download, up to about 2 megapixels"
  Write-Host "    24   Q8 models, about 18 GB to download, up to native 2K"
  $Vram = (Read-Host "  Type 12, 16, or 24").Trim()
  if ($Vram -notin @('12', '16', '24')) { throw "Please run this again and choose 12, 16, or 24." }
}

$packs = @{
  '12' = @{ dit = 'Qwen-Image-2.1-Turbo-AD-Q4_K.gguf'; te = 'Qwen-Image-2.1-Turbo-Uncensored-AD-Q4_K.gguf'; ditMin = 4000000000; teMin = 5000000000 }
  '16' = @{ dit = 'Qwen-Image-2.1-Turbo-AD-Q5_K.gguf'; te = 'Qwen-Image-2.1-Turbo-Uncensored-AD-Q5_K.gguf'; ditMin = 5000000000; teMin = 6000000000 }
  '24' = @{ dit = 'Qwen-Image-2.1-Turbo-Q8_0.gguf'; te = 'Qwen-Image-2.1-Turbo-Uncensored-Q8_0.gguf'; ditMin = 7000000000; teMin = 8000000000 }
}
$pack = $packs[$Vram]

function Find-Comfy([string]$hint) {
  $cands = @()
  if ($hint) { $cands += $hint }
  if ($env:COMFY_ROOT) { $cands += $env:COMFY_ROOT }
  $cands += @(
    (Join-Path $root 'ComfyUI'),
    (Join-Path $root '..\ComfyUI-Fresh\ComfyUI_windows_portable'),
    (Join-Path $root '..\ComfyUI_windows_portable')
  )
  foreach ($c in $cands) {
    if ($c -and (Test-Path (Join-Path $c 'run_nvidia_gpu.bat'))) { return (Resolve-Path $c).Path }
  }
  return $null
}

Say "ComfyUI"
$comfy = Find-Comfy $ComfyRoot
if (-not $comfy) {
  $typed = Read-Host "  Paste a ComfyUI folder that contains run_nvidia_gpu.bat, or press Enter to download one (about 2 GB)"
  if ($typed) {
    $comfy = Find-Comfy $typed.Trim('"')
    if (-not $comfy) { throw "That folder does not contain run_nvidia_gpu.bat." }
  } else {
    $seven = $null
    foreach ($p in @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe')) { if (Test-Path $p) { $seven = $p; break } }
    if (-not $seven -and (Have-Cmd '7z')) { $seven = (Get-Command 7z).Source }
    if (-not $seven) {
      Write-Host "  7-Zip is needed to unpack ComfyUI. Trying winget..."
      if (-not (Have-Cmd 'winget')) { throw "Install 7-Zip from https://www.7-zip.org and run Install.bat again." }
      winget install --id 7zip.7zip -e --accept-package-agreements --accept-source-agreements
      $seven = 'C:\Program Files\7-Zip\7z.exe'
      if (-not (Test-Path $seven)) { throw "7-Zip was installed. Close this window and double-click Install.bat again." }
    }
    Write-Host "  asking GitHub for the latest Windows NVIDIA portable build"
    $headers = @{ 'User-Agent' = 'qwen-studio'; 'Accept' = 'application/vnd.github+json' }
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest' -Headers $headers
    $asset = $rel.assets | Where-Object { $_.name -eq 'ComfyUI_windows_portable_nvidia.7z' } | Select-Object -First 1
    if (-not $asset) { throw "The latest ComfyUI release has no ComfyUI_windows_portable_nvidia.7z. Install ComfyUI yourself and pass -ComfyRoot." }
    $archive = Join-Path $env:TEMP 'ComfyUI_windows_portable_nvidia.7z'
    Get-File $asset.browser_download_url $archive 500000000
    $unpack = Join-Path $root 'ComfyUI'
    if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
    Write-Host "  unpacking"
    & $seven x $archive "-o$root" -y | Out-Null
    $nested = Join-Path $root 'ComfyUI_windows_portable'
    if (Test-Path (Join-Path $nested 'run_nvidia_gpu.bat')) { Rename-Item $nested 'ComfyUI' }
    $comfy = Find-Comfy (Join-Path $root 'ComfyUI')
    if (-not $comfy) { throw "ComfyUI unpacked, but run_nvidia_gpu.bat was not where I expected." }
  }
}
Write-Host "  $comfy"

Say "GGUF loaders"
$cn = Join-Path $comfy 'ComfyUI\custom_nodes'
if (-not (Test-Path $cn)) { New-Item -ItemType Directory -Force -Path $cn | Out-Null }
function Install-Zip($url, $dest) {
  if (Test-Path $dest) { Write-Host "  have $(Split-Path $dest -Leaf)"; return }
  $zip = Join-Path $env:TEMP ((Split-Path $dest -Leaf) + '.zip')
  Write-Host "  downloading $(Split-Path $dest -Leaf)"
  & curl.exe -L --fail --retry 5 -o $zip $url
  if ($LASTEXITCODE -ne 0) { throw "Could not download $url" }
  $tmp = Join-Path $env:TEMP ([guid]::NewGuid().ToString('n'))
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Move-Item $inner.FullName $dest
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Install-Zip 'https://github.com/city96/ComfyUI-GGUF/archive/refs/heads/main.zip' (Join-Path $cn 'ComfyUI-GGUF')
Install-Zip 'https://github.com/pottokao-dotcom/ComfyUI-GGUF-Qwen3VL-TE/archive/refs/heads/main.zip' (Join-Path $cn 'ComfyUI-GGUF-Qwen3VL-TE')
$py = Join-Path $comfy 'python_embeded\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }
Write-Host "  installing Python packages for the GGUF loader"
& $py -m pip install -q -r (Join-Path $cn 'ComfyUI-GGUF\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw "pip install failed. If ComfyUI is using its own Python, install gguf into that environment." }

Say "$Vram GB models"
$ditDir = Join-Path $comfy 'ComfyUI\models\diffusion_models'
$teDir = Join-Path $comfy 'ComfyUI\models\text_encoders'
$vaeDir = Join-Path $comfy 'ComfyUI\models\vae'
$ditBase = 'https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-GGUF/resolve/main'
$teBase = 'https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF/resolve/main'
Get-File "$ditBase/$($pack.dit)" (Join-Path $ditDir $pack.dit) $pack.ditMin
Get-File "$teBase/$($pack.te)" (Join-Path $teDir $pack.te) $pack.teMin
$mm = Join-Path $teDir 'mmproj-Qwen-Image-2.1-Turbo-Uncensored-F16.gguf'
Get-File "$teBase/mmproj-Qwen-Image-2.1-Turbo-Uncensored-F16.gguf" $mm 1000000000
$alias = Join-Path $teDir 'mmproj-Qwen-Image-2.1-Turbo-Uncensored-AD-F16.gguf'
if (-not (Test-Path $alias)) {
  cmd /c mklink /H "$alias" "$mm" | Out-Null
  if (-not (Test-Path $alias)) { Copy-Item $mm $alias }
  Write-Host "  linked the vision file for the Q4/Q5 encoders"
}
Get-File 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors' (Join-Path $vaeDir 'qwen_image_2.1_vae_bf16.safetensors') 200000000

Say "Settings"
$utf8 = New-Object System.Text.UTF8Encoding $false
$defaults = [System.IO.File]::ReadAllText((Join-Path $root 'config\defaults.json'), $utf8) | ConvertFrom-Json
$settingsPath = Join-Path $root 'config\settings.json'
if (Test-Path $settingsPath) { $data = [System.IO.File]::ReadAllText($settingsPath, $utf8) | ConvertFrom-Json } else { $data = $defaults }
$data.app.comfyRoot = $comfy
$data.app.vram = $Vram
if ($Port -gt 0) { $data.app.port = $Port }
$chosen = $data.app.profiles.$Vram
$data.gen.model = $Vram
$data.gen.megapixels = $chosen.defaultMp
$data.gen.cacheDevice = $chosen.cacheDevice
$data.gen.cacheDtype = $chosen.cacheDtype
$data.gen.upscaleMaxMp = $chosen.maxMp
if ($Vram -eq '12') {
  $data.app.launchExtraArgs = @('--disable-auto-launch', '--preview-method', 'auto', '--disable-dynamic-vram', '--lowvram')
} else {
  $data.app.launchExtraArgs = @('--disable-auto-launch', '--preview-method', 'auto', '--disable-dynamic-vram')
}
$json = $data | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($settingsPath, $json, $utf8)
Write-Host "  $Vram GB pack is the default. Run Install.bat again to add another size."

Say "Shortcut"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'create-shortcut.ps1')

if ($NoLaunch) {
  Write-Host ""
  Write-Host "Done. If ComfyUI is already open, restart it so it sees the new files."
  return
}
Write-Host ""
Write-Host "Opening Qwen Studio. If ComfyUI was already running, restart it once so it sees the new models."
Start-Process -FilePath (Join-Path $root 'Qwen Studio.bat')
