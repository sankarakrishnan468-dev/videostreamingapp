const { randomUUID } = require("crypto");
const os = require("os");
const { performance } = require("perf_hooks");

const API_BASE_URL = (process.env.API_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || "http://localhost:8888").replace(/\/+$/, "");
const ROOM_ID = process.env.LIVE_ROOM_ID;
const VIEWERS = Number(process.env.VIEWERS || 500);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 120);
const RAMP_UP_SECONDS = Number(process.env.RAMP_UP_SECONDS || 30);
const HEARTBEAT_INTERVAL_MS = 20_000;
const SEGMENT_INTERVAL_MS = 2_000;

if (!ROOM_ID || !/^[a-f\d]{32}$/i.test(ROOM_ID)) {
  throw new Error("Set LIVE_ROOM_ID to the 32-character ID of an active live stream.");
}
if (!Number.isInteger(VIEWERS) || VIEWERS < 1 || VIEWERS > 5000) {
  throw new Error("VIEWERS must be an integer between 1 and 5000.");
}
if (!Number.isFinite(DURATION_SECONDS) || DURATION_SECONDS < 15) {
  throw new Error("DURATION_SECONDS must be at least 15.");
}

const startedAt = performance.now();
const deadline = startedAt + DURATION_SECONDS * 1000;
const metrics = {
  started: 0,
  playbackSuccess: 0,
  segmentRequests: 0,
  successfulSegments: 0,
  bytesDownloaded: 0,
  bytesFailed: 0,
  requestErrors: 0,
  latenciesMs: [],
  startupLatenciesMs: [],
  errors: []
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
  const requestStartedAt = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.arrayBuffer();
  const latencyMs = performance.now() - requestStartedAt;
  metrics.latenciesMs.push(latencyMs);
  if (!response.ok) {
    metrics.bytesFailed += body.byteLength;
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return { response, body: Buffer.from(body), latencyMs };
}

async function getMediaPlaylist() {
  const master = new URL(`/${ROOM_ID}/index.m3u8`, LIVE_BASE_URL);
  const { body: masterBody } = await request(master);
  const masterText = masterBody.toString("utf8");
  const lines = masterText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const childPlaylist = lines.find((line) => !line.startsWith("#") && line.endsWith(".m3u8"));
  if (!childPlaylist) return { url: master, text: masterText };

  const mediaUrl = new URL(childPlaylist, master);
  const { body: mediaBody } = await request(mediaUrl);
  return { url: mediaUrl, text: mediaBody.toString("utf8") };
}

function getLatestMediaResource(playlist) {
  const lines = playlist.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const segment = [...lines].reverse().find((line) => !line.startsWith("#") && !line.endsWith(".m3u8"));
  if (segment) return new URL(segment, playlist.url);

  const parts = [...playlist.text.matchAll(/#EXT-X-PART:[^\r\n]*URI="([^"]+)"/g)];
  return parts.length ? new URL(parts[parts.length - 1][1], playlist.url) : null;
}

async function runViewer(index) {
  const sessionId = randomUUID();
  const viewerStartedAt = performance.now();
  let hasDownloadedMedia = false;
  let lastHeartbeatAt = 0;
  metrics.started += 1;

  const heartbeat = async () => {
    const response = await fetch(`${API_BASE_URL}/api/live/${ROOM_ID}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewerSessionId: sessionId }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Viewer ${index + 1} heartbeat failed: HTTP ${response.status} ${body}`);
    lastHeartbeatAt = performance.now();
  };

  try {
    await heartbeat();
    while (performance.now() < deadline) {
      try {
        if (performance.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) await heartbeat();
        const playlist = await getMediaPlaylist();
        const mediaUrl = getLatestMediaResource(playlist);
        if (!mediaUrl) throw new Error("No media segment or part is available in the HLS playlist yet.");
        const { body, latencyMs } = await request(mediaUrl);
        metrics.segmentRequests += 1;
        metrics.successfulSegments += 1;
        metrics.bytesDownloaded += body.byteLength;
        if (!hasDownloadedMedia) {
          hasDownloadedMedia = true;
          metrics.playbackSuccess += 1;
          metrics.startupLatenciesMs.push(performance.now() - viewerStartedAt);
        }
        if (!body.byteLength) throw new Error(`The HLS media resource was empty (${latencyMs.toFixed(0)}ms).`);
      } catch (error) {
        metrics.requestErrors += 1;
        if (metrics.errors.length < 30) metrics.errors.push(error.message);
      }
      await wait(SEGMENT_INTERVAL_MS);
    }
  } catch (error) {
    metrics.requestErrors += 1;
    if (metrics.errors.length < 30) metrics.errors.push(error.message);
  } finally {
    try {
      await fetch(`${API_BASE_URL}/api/live/${ROOM_ID}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewerSessionId: sessionId }),
        signal: AbortSignal.timeout(10000)
      });
    } catch (error) {
      metrics.requestErrors += 1;
      if (metrics.errors.length < 30) metrics.errors.push(`Viewer ${index + 1} leave failed: ${error.message}`);
    }
  }
}

function percentile(values, proportion) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * proportion))];
}

function printMetrics() {
  const durationSeconds = (performance.now() - startedAt) / 1000;
  const cpuDelta = process.cpuUsage();
  const sortedLatencies = metrics.latenciesMs;
  const result = {
    roomId: ROOM_ID,
    requestedViewers: VIEWERS,
    startedViewers: metrics.started,
    durationSeconds: Number(durationSeconds.toFixed(1)),
    successfulPlaybackSessions: metrics.playbackSuccess,
    playbackSuccessRate: `${((metrics.playbackSuccess / Math.max(1, metrics.started)) * 100).toFixed(2)}%`,
    startupLatencyMs: {
      p50: Number(percentile(metrics.startupLatenciesMs, 0.5).toFixed(0)),
      p95: Number(percentile(metrics.startupLatenciesMs, 0.95).toFixed(0)),
      max: Number(Math.max(0, ...metrics.startupLatenciesMs).toFixed(0))
    },
    requestLatencyMs: {
      p50: Number(percentile(sortedLatencies, 0.5).toFixed(0)),
      p95: Number(percentile(sortedLatencies, 0.95).toFixed(0)),
      max: Number(Math.max(0, ...sortedLatencies).toFixed(0))
    },
    hlsSegmentRequests: metrics.segmentRequests,
    downloadedMiB: Number((metrics.bytesDownloaded / (1024 * 1024)).toFixed(2)),
    averageDownloadMbps: Number(((metrics.bytesDownloaded * 8) / Math.max(1, durationSeconds) / 1_000_000).toFixed(2)),
    requestErrors: metrics.requestErrors,
    process: {
      cpuTimeMs: Math.round((cpuDelta.user + cpuDelta.system) / 1000),
      memoryMiB: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
      hostLoadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
      hostLogicalCpus: os.cpus().length
    },
    errorSamples: metrics.errors
  };
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const streamResponse = await fetch(`${API_BASE_URL}/api/live/${ROOM_ID}`, {
    signal: AbortSignal.timeout(15000)
  });
  const streamData = await streamResponse.json();
  if (!streamResponse.ok) throw new Error(streamData.error || `Stream check failed: HTTP ${streamResponse.status}`);
  if (streamData.stream.streamStatus !== "live") throw new Error("The requested stream is not live.");

  const rampIntervalMs = Math.max(0, (RAMP_UP_SECONDS * 1000) / VIEWERS);
  const workers = [];
  for (let index = 0; index < VIEWERS; index += 1) {
    workers.push((async () => {
      if (rampIntervalMs) await wait(index * rampIntervalMs);
      await runViewer(index);
    })());
  }

  await Promise.all(workers);
  printMetrics();
  const successRate = metrics.playbackSuccess / Math.max(1, metrics.started);
  if (metrics.started < VIEWERS || successRate < 0.99 || metrics.requestErrors > Math.max(5, VIEWERS * 0.01)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Live load test failed:", error);
  process.exitCode = 1;
});
