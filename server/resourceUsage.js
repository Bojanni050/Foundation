// Lightweight self-sampling CPU/memory monitor for a Node process. Each
// process that requires this module gets its own independent sampler (module
// state is per-process, not shared) — exactly what's needed since Chronicle's
// capture process and memory-process are separate OS processes reporting on
// themselves. Samples on a fixed interval and caches the result, rather than
// double-sampling process.cpuUsage() per request, which would add latency to
// every request that asks for it.
const SAMPLE_INTERVAL_MS = 2000;

let lastCpu = process.cpuUsage();
let lastTime = process.hrtime.bigint();
let latest = {
  pid: process.pid,
  cpuPercent: 0,
  memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
};

const timer = setInterval(() => {
  const cpuDelta = process.cpuUsage(lastCpu);
  const now = process.hrtime.bigint();
  const elapsedMs = Number(now - lastTime) / 1e6;
  const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
  latest = {
    pid: process.pid,
    // Relative to one CPU core (same convention as Unix `top`) — a process
    // pegging one full core reads 100%, not 100%/numCores.
    cpuPercent: elapsedMs > 0 ? Math.round((cpuMs / elapsedMs) * 1000) / 10 : 0,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  lastCpu = process.cpuUsage();
  lastTime = now;
}, SAMPLE_INTERVAL_MS);
timer.unref(); // never keeps the process alive on its own

function getResourceUsage() {
  return latest;
}

module.exports = { getResourceUsage };
