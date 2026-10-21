// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Run the app's own PowerShell scripts (windows/scripts/*.ps1, shipped with it): normally, or
// elevated (one UAC prompt, waits for it to finish), with named arguments. Nothing is written to
// temp and run from there, and nothing is an encoded or inline command: scripts dropped into temp
// and run with -Command are what droppers do, and antivirus heuristics (VirusTotal) flag the app for it.
// The values only ever go in as arguments, so none of them is ever read as PowerShell.
const { execFile } = require('child_process');
const path = require('path');

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const DIR = path.join(__dirname, 'scripts');
const ELEVATE = path.join(DIR, 'elevate.ps1');
const BASE = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

// Started from a PowerShell 7 terminal, PSModulePath lists PowerShell 7's modules first and
// Windows PowerShell 5.1 then loads the wrong PKI/NetSecurity modules. Without it, 5.1 uses its own.
const env = { ...process.env };
delete env.PSModulePath;

// {Name: value} -> ['-Name', 'value']; true is a switch, false/''/null left out (powershell.exe
// -File drops empty arguments, so a parameter's default stands in).
function argv(args) {
  const out = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (v === true) out.push('-' + k);
    else if (v !== false && v !== null && v !== undefined && v !== '') out.push('-' + k, String(v));
  }
  return out;
}

const file = (name) => path.join(DIR, name + '.ps1');

function exec(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(PS, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
        else resolve(String(stdout));
      });
  });
}

// scripts/<name>.ps1 with args; resolves with what it printed.
function script(name, args = {}, timeoutMs = 60000) {
  return exec([...BASE, file(name), ...argv(args)], timeoutMs);
}

// One argument on a Windows command line (the C runtime's rules: Start-Process hands the elevated
// powershell.exe a single string).
function quote(a) {
  if (a && !/[\s"]/.test(a)) return a;
  let s = '"';
  for (let i = 0, slashes = 0; i < a.length; i++) {
    const c = a[i];
    if (c === '\\') { slashes++; continue; }
    s += '\\'.repeat(c === '"' ? slashes * 2 + 1 : slashes) + c;
    slashes = 0;
  }
  const trailing = /\\*$/.exec(a)[0].length;
  return s + '\\'.repeat(trailing * 2) + '"';
}

// Elevated through scripts/elevate.ps1: throws if the UAC prompt is declined. The script's errors
// can't be read back directly, so callers re-check the state afterwards (or read its -Log file).
function scriptElevated(name, args = {}, timeoutMs = 120000) {
  const line = [...BASE, file(name), ...argv(args)].map(quote).join(' ');
  return exec([...BASE, ELEVATE, '-ArgLine', line], timeoutMs);
}

module.exports = { script, scriptElevated, PS, DIR, quote };
