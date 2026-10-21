# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Run elevated once (vdd.js): installs the Virtual Display Driver
# (https://github.com/VirtualDrivers/Virtual-Display-Driver, MIT, signed by SignPath Foundation)
# for Display › PC → Mac › Extend, leaves its monitor switched off, and adds two scheduled tasks
# (\MacShare\Extend on / off, run as SYSTEM) that this user may start without a UAC prompt.
param(
  [Parameter(Mandatory = $true)][string]$Helper,
  [Parameter(Mandatory = $true)][string]$UserSid,
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Sha256
)
$ErrorActionPreference = 'Stop'
$HwId = 'Root\MttVDD'
try {
  $dir = Join-Path $env:ProgramData 'MacShare\vdd'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $zip = Join-Path $dir 'driver.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing
  if ((Get-FileHash -Algorithm SHA256 $zip).Hash -ne $Sha256) { throw 'the driver download has the wrong checksum' }
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  $pkg = Join-Path $dir 'VirtualDisplayDriver'
  $inf = Join-Path $pkg 'MttVDD.inf'

  # Trust the publisher (only after Windows says the catalog signature is valid).
  $sig = Get-AuthenticodeSignature (Join-Path $pkg 'mttvdd.cat')
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'CN=SignPath Foundation') { throw 'the driver signature is not valid' }
  $store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPublisher', 'LocalMachine')
  $store.Open('ReadWrite'); $store.Add($sig.SignerCertificate); $store.Close()

  # The driver's settings folder: keep an existing one; this user may edit it (resolutions).
  $cfg = 'C:\VirtualDisplayDriver'
  New-Item -ItemType Directory -Force -Path $cfg | Out-Null
  if (-not (Test-Path (Join-Path $cfg 'vdd_settings.xml'))) { Copy-Item (Join-Path $pkg 'vdd_settings.xml') $cfg }
  & icacls.exe $cfg /grant "*${UserSid}:(OI)(CI)M" | Out-Null

  $find = { Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains $HwId } }
  if (-not (& $find)) {
    $p = Start-Process -FilePath $Helper -ArgumentList '--add-root-device', ('"' + $inf + '"'), $HwId -Wait -PassThru -WindowStyle Hidden
    if ($p.ExitCode -ne 0) {
      # The helper exits with Windows' error. 0x800B0109 (CERT_E_UNTRUSTEDROOT): Code Integrity
      # refused the package's signature, as Windows on ARM does for drivers that aren't Microsoft-signed.
      $code = '{0:X8}' -f $p.ExitCode
      if ($code -eq '800B0109') { throw 'Windows refused the driver''s signature (0x800B0109)' }
      throw ('the display driver did not install (error 0x' + $code + ', see C:\Windows\INF\setupapi.dev.log)')
    }
    Set-Content -Path (Join-Path $dir 'installed-by-macshare') -Value (Get-Date -Format o)
    Start-Sleep -Seconds 3
  }
  & $find | Disable-PnpDevice -Confirm:$false

  # Scheduled tasks: SYSTEM runs Enable/Disable-PnpDevice; this user may read and run them.
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $root = $svc.GetFolder('\')
  try { $folder = $root.GetFolder('MacShare') } catch { $folder = $root.CreateFolder('MacShare') }
  $sddl = "D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;$UserSid)"
  foreach ($t in @(@('Extend on', 'Enable'), @('Extend off', 'Disable'))) {
    $cmd = "Get-PnpDevice -Class Display | Where-Object { `$_.HardwareID -contains '$HwId' } | $($t[1])-PnpDevice -Confirm:`$false"
    $def = $svc.NewTask(0)
    $def.RegistrationInfo.Description = 'MacShare: switch the virtual PC monitor (Display > PC to Mac > Extend)'
    $def.Settings.ExecutionTimeLimit = 'PT2M'
    $def.Settings.DisallowStartIfOnBatteries = $false
    $def.Settings.StopIfGoingOnBatteries = $false
    $def.Settings.MultipleInstances = 1 # queue
    $a = $def.Actions.Create(0)
    $a.Path = $ps
    $a.Arguments = '-NoProfile -NonInteractive -Command "' + $cmd + '"' # as SYSTEM: no window to hide
    $folder.RegisterTaskDefinition($t[0], $def, 6, 'SYSTEM', $null, 5, $sddl) | Out-Null
  }
  Set-Content -Path $Log -Value 'ok'
} catch {
  Set-Content -Path $Log -Value ('error: ' + $_.Exception.Message)
}
