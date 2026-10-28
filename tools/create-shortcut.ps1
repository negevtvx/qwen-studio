# Creates the desktop shortcut. If "Qwen Studio" already points somewhere else, uses "Qwen Studio VRAM".
param([string]$Name)
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$bat = Join-Path $root 'Qwen Studio.bat'
$lnkPath = Join-Path $desktop $(if ($Name) { $Name } else { 'Qwen Studio.lnk' })
if (-not $Name -and (Test-Path $lnkPath)) {
  $existing = $shell.CreateShortcut($lnkPath)
  if ($existing.TargetPath -and ($existing.TargetPath -ne $bat)) {
    $lnkPath = Join-Path $desktop 'Qwen Studio VRAM.lnk'
  }
}
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $bat
$lnk.WorkingDirectory = $root
$lnk.IconLocation = (Join-Path $root 'public\icon.ico') + ',0'
$lnk.WindowStyle = 7
$lnk.Description = 'Qwen Studio - Qwen Image 2.1 Turbo, sized for your VRAM'
$lnk.Save()
Write-Output "Shortcut: $lnkPath"
