// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This computer's own controls, for the other device's Overview (shared/devctl.js): ring until
// stopped, lock, sleep, Bluetooth on or off, Do not disturb, the output volume. Each platform's
// way, with what it can't do left out of can() (an older system, a missing tool):
//   Windows: PowerShell (a looping alarm sound, LockWorkStation, SetSuspendState, the WinRT Radio
//     API, the toast setting Do not disturb uses, the Core Audio endpoint volume).
//   Mac: afplay, CGSession / pmset, blueutil when it's installed (Homebrew), osascript's volume.
//     Focus has no interface for apps: no Do not disturb.
//   Linux: paplay / canberra, loginctl, systemctl suspend, bluetoothctl, GNOME's show-banners,
//     wpctl or pactl.
// new DevLocal() → {can(), state() → Promise<{bluetooth?, dnd?, volume?, ringing}>, do(cmd) → Promise}
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => resolve({ ok: !err, out: String(out || '').trim(), err }));
});
const ps = (script, timeout) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout);
const which = (name) => (process.env.PATH || '').split(path.delimiter).some((d) => { try { return fs.statSync(path.join(d, name)).isFile(); } catch (_) { return false; } });
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// Windows: the default output's volume through Core Audio (IAudioEndpointVolume), compiled once per call.
const WIN_VOL = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float l, Guid c); int j(); int GetMasterVolumeLevelScalar(out float l); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
public static class TdVol {
  static IAudioEndpointVolume Ep() { var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom()); IMMDevice d; e.GetDefaultAudioEndpoint(0, 1, out d);
    var id = typeof(IAudioEndpointVolume).GUID; object o; d.Activate(ref id, 23, IntPtr.Zero, out o); return (IAudioEndpointVolume)o; }
  public static float Get() { float l; Ep().GetMasterVolumeLevelScalar(out l); return l; }
  public static void Set(float l) { Ep().SetMasterVolumeLevelScalar(l, Guid.Empty); }
}
'@`;
// Windows: the Bluetooth radio through WinRT (no administrator rights needed).
const WIN_BT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$await = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $task = $await.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$bt = $radios | ? { $_.Kind -eq 'Bluetooth' } | Select-Object -First 1`;
const WIN_DND_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';

class DevLocal {
  constructor() {
    this.os = process.platform;
    this.ringer = null; // the ringing process
    this.caps = this._caps();
  }

  _caps() {
    if (this.os === 'win32') return { ring: true, lock: true, sleep: true, bluetooth: true, dnd: true, volume: true };
    if (this.os === 'darwin') return { ring: true, lock: true, sleep: true, bluetooth: which('blueutil') || fs.existsSync('/opt/homebrew/bin/blueutil') || fs.existsSync('/usr/local/bin/blueutil'), dnd: false, volume: true };
    const gnome = /GNOME|Unity|Pantheon|Budgie/i.test(process.env.XDG_CURRENT_DESKTOP || '') && which('gsettings');
    return {
      ring: which('paplay') || which('pw-play') || which('canberra-gtk-play'),
      lock: which('loginctl'), sleep: which('systemctl'), bluetooth: which('bluetoothctl'),
      dnd: !!gnome, volume: which('wpctl') || which('pactl'),
    };
  }

  can() {
    return { ...this.caps };
  }

  get ringing() {
    return !!this.ringer;
  }

  async state() {
    const s = { ringing: this.ringing };
    try {
      if (this.os === 'win32') {
        const r = await ps(`${WIN_BT}
$o = @{}; if ($bt) { $o.bt = [string]$bt.State }; $v = (Get-ItemProperty -Path '${WIN_DND_KEY}' -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -ErrorAction SilentlyContinue).NOC_GLOBAL_SETTING_TOASTS_ENABLED; $o.dnd = ($v -eq 0); $o | ConvertTo-Json -Compress`, 15000);
        const v = await ps(`${WIN_VOL}\n[TdVol]::Get()`, 15000);
        const j = r.ok && r.out ? JSON.parse(r.out) : {};
        if (j.bt) s.bluetooth = j.bt === 'On';
        else this.caps.bluetooth = false;
        s.dnd = !!j.dnd;
        if (v.ok && v.out !== '') s.volume = clamp01(parseFloat(v.out.replace(',', '.')));
      } else if (this.os === 'darwin') {
        const v = await run('osascript', ['-e', 'output volume of (get volume settings)']);
        if (v.ok) s.volume = clamp01(Number(v.out) / 100);
        if (this.caps.bluetooth) {
          const b = await run(this._blueutil(), ['-p']);
          if (b.ok) s.bluetooth = b.out === '1';
        }
      } else {
        if (this.caps.volume) {
          const v = which('wpctl') ? await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']) : await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
          const m = /Volume:\s*([\d.]+)/.exec(v.out) || /(\d+)%/.exec(v.out);
          if (m) s.volume = clamp01(m[0].includes('%') ? Number(m[1]) / 100 : Number(m[1]));
        }
        if (this.caps.bluetooth) {
          const b = await run('bluetoothctl', ['show']);
          if (b.ok && /Powered:/.test(b.out)) s.bluetooth = /Powered:\s*yes/.test(b.out);
          else this.caps.bluetooth = false; // no controller
        }
        if (this.caps.dnd) {
          const d = await run('gsettings', ['get', 'org.gnome.desktop.notifications', 'show-banners']);
          if (d.ok) s.dnd = d.out === 'false';
        }
      }
    } catch (e) { /* left out: not reported */ }
    return s;
  }

  _blueutil() {
    return ['/opt/homebrew/bin/blueutil', '/usr/local/bin/blueutil'].find((p) => fs.existsSync(p)) || 'blueutil';
  }

  // cmd: {do: 'ring'|'ringStop'|'lock'|'sleep'|'bluetooth'|'dnd'|'volume', on?, level?}
  async do(cmd) {
    const c = cmd || {};
    if (!this.caps[c.do === 'ringStop' ? 'ring' : c.do]) return;
    switch (c.do) {
      case 'ring': return this._ring(true);
      case 'ringStop': return this._ring(false);
      case 'lock':
        if (this.os === 'win32') return run('rundll32.exe', ['user32.dll,LockWorkStation']);
        if (this.os === 'darwin') {
          const cg = '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession';
          return fs.existsSync(cg) ? run(cg, ['-suspend']) : run('pmset', ['displaysleepnow']);
        }
        return run('loginctl', ['lock-session']);
      case 'sleep':
        this._ring(false);
        if (this.os === 'win32') return ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)");
        if (this.os === 'darwin') return run('pmset', ['sleepnow']);
        return run('systemctl', ['suspend']);
      case 'bluetooth': {
        const on = !!c.on;
        if (this.os === 'win32') return ps(`${WIN_BT}; if ($bt) { Await ($bt.SetStateAsync([Windows.Devices.Radios.RadioState]::${on ? 'On' : 'Off'})) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null }`, 15000);
        if (this.os === 'darwin') return run(this._blueutil(), ['-p', on ? '1' : '0']);
        return run('bluetoothctl', ['power', on ? 'on' : 'off']);
      }
      case 'dnd': {
        const on = !!c.on;
        if (this.os === 'win32') return ps(`New-Item -Path '${WIN_DND_KEY}' -Force | Out-Null; Set-ItemProperty -Path '${WIN_DND_KEY}' -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -Type DWord -Value ${on ? 0 : 1}`);
        return run('gsettings', ['set', 'org.gnome.desktop.notifications', 'show-banners', on ? 'false' : 'true']);
      }
      case 'volume': {
        const l = clamp01(c.level);
        if (this.os === 'win32') return ps(`${WIN_VOL}\n[TdVol]::Set(${l.toFixed(3)})`, 15000);
        if (this.os === 'darwin') return run('osascript', ['-e', `set volume output volume ${Math.round(l * 100)}`]);
        return which('wpctl') ? run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', l.toFixed(2)]) : run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', Math.round(l * 100) + '%']);
      }
      default:
    }
  }

  // Rings until stopped (or two minutes), at the volume the computer is at.
  _ring(on) {
    if (this.ringer) {
      try { this.ringer.kill(); } catch (_) { /* gone */ }
      this.ringer = null;
      clearTimeout(this.ringTimer);
    }
    this._pop(false);
    if (!on) return;
    let p;
    if (this.os === 'win32') {
      const wav = ['Alarm01.wav', 'Ring01.wav', 'notify.wav'].map((f) => path.join(process.env.SystemRoot || 'C:\\Windows', 'Media', f)).find((f) => fs.existsSync(f));
      if (!wav) return;
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = New-Object Media.SoundPlayer '${wav}'; $p.PlayLooping(); Start-Sleep -Seconds 120`], { windowsHide: true, stdio: 'ignore' });
    } else if (this.os === 'darwin') {
      p = spawn('/bin/sh', ['-c', 'while :; do afplay /System/Library/Sounds/Sosumi.aiff; done'], { stdio: 'ignore', detached: true });
    } else {
      const snd = ['/usr/share/sounds/freedesktop/stereo/phone-incoming-call.oga', '/usr/share/sounds/freedesktop/stereo/bell.oga', '/usr/share/sounds/freedesktop/stereo/complete.oga'].find((f) => fs.existsSync(f));
      const player = which('pw-play') ? 'pw-play' : which('paplay') ? 'paplay' : null;
      const line = snd && player ? `${player} '${snd}'` : 'canberra-gtk-play -i phone-incoming-call';
      p = spawn('/bin/sh', ['-c', `while :; do ${line}; sleep 0.3; done`], { stdio: 'ignore', detached: true });
    }
    this.ringer = p;
    p.on('exit', () => { if (this.ringer === p) { this.ringer = null; this._pop(false); if (this.onStop) this.onStop(); } });
    this._pop(true);
    this.ringTimer = setTimeout(() => this._ring(false), 120000);
    // The shell loops on Mac and Linux: the whole group goes when it's stopped.
    if (this.os !== 'win32') {
      const kill = p.kill.bind(p);
      p.kill = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch (_) { kill(); } };
    }
  }

  stop() {
    this._ring(false);
  }

  // While it rings: a notification that stays, Stop on it (or a click), so it can be stopped here
  // too, not only from the device that rang. ringFrom: that device's name (DevCtl sets it).
  _pop(on) {
    if (this.note) { const n = this.note; this.note = null; try { n.close(); } catch (_) { /* gone */ } }
    if (!on) return;
    let Notification;
    try { ({ Notification } = require('electron')); } catch (_) { return; } // not in Electron (tests)
    if (!Notification || !Notification.isSupported()) return;
    const stop = () => { this._ring(false); if (this.onStop) this.onStop(); };
    const n = new Notification({
      title: 'Ringing',
      body: (this.ringFrom ? this.ringFrom : 'Another device') + ' is ringing this computer. Click to stop.',
      silent: true,
      timeoutType: 'never',
      urgency: 'critical',
      actions: [{ type: 'button', text: 'Stop' }],
    });
    n.on('click', stop);
    n.on('action', stop);
    this.note = n;
    n.show();
  }
}

module.exports = { DevLocal };
