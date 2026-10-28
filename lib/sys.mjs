// Windows system helpers: GPU stats, port owner lookup, targeted process kill, Explorer, Recycle Bin.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const opts = { windowsHide: true, timeout: 8000 };

export async function gpuStats() {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'], opts);
    const [name, used, total, util, temp] = stdout.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
    return { name, usedMB: +used, totalMB: +total, util: +util, temp: +temp };
  } catch {
    return null;
  }
}

// PID of whatever is LISTENING on the given local TCP port (IPv4 or IPv6), or null.
export async function findListeningPid(port) {
  try {
    const { stdout } = await run('netstat', ['-ano'], opts);
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
      if (cols[1].endsWith(`:${port}`)) return Number(cols[4]);
    }
  } catch { /* netstat unavailable */ }
  return null;
}

export async function processInfo(pid) {
  try {
    const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], opts);
    const m = stdout.match(/^"([^"]+)","(\d+)"/m);
    return m ? { name: m[1], pid: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

// Kills exactly one process tree, identified by PID. Never by image name.
export async function killTree(pid) {
  try {
    const { stdout } = await run('taskkill', ['/PID', String(pid), '/T', '/F'], opts);
    return { ok: true, output: stdout.trim() };
  } catch (e) {
    return { ok: false, output: (e.stdout || e.message || '').trim() };
  }
}

export function killTreeSync(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* best effort on shutdown */ }
}

export function reveal(filePath, select = true) {
  const args = select ? [`/select,"${filePath}"`] : [`"${filePath}"`];
  spawn('explorer.exe', args, { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
}

// Sends files to the Recycle Bin (recoverable) instead of deleting them.
export async function recycle(paths) {
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$env:QS_PATHS -split "`n" | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | ForEach-Object {',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
  ].join('\n');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { ...opts, env: { ...process.env, QS_PATHS: paths.join('\n') } });
}
