import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import LiveEngagement from "../components/LiveEngagement.jsx";
import "./Streamer.css";
import "./LiveStreaming.css";

function formatDuration(startedAt, endedAt) {
  if (!startedAt) return "--";
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const diffSec = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function StreamDetails() {
  const { roomId } = useParams();
  const [stream, setStream] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let active = true;
    const fetchDetails = async () => {
      try {
        const response = await fetch(`/api/live/${roomId}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load stream details.");
        if (active) {
          setStream(data.stream);
          setError("");
        }
      } catch (err) {
        if (active) {
          console.error("Could not load stream details:", err);
          setError(err.message || "Could not load stream details.");
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchDetails();
    const interval = window.setInterval(() => void fetchDetails(), 10000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [roomId]);

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 2500);
    } catch {
      setCopied("Failed to copy");
    }
  };

  const shareStream = async () => {
    const watchUrl = new URL(`/viewer/${roomId}`, window.location.origin).href;
    try {
      if (navigator.share) {
        await navigator.share({
          title: stream?.title || "Live Stream",
          text: stream?.description || "Watch this live broadcast on streamline!",
          url: watchUrl
        });
      } else {
        await copyText(watchUrl, "Watch link copied to clipboard!");
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        await copyText(watchUrl, "Watch link copied to clipboard!");
      }
    }
  };

  const isLive = stream?.streamStatus === "live" && !stream?.endedAt;

  return (
    <main className="viewer-page live-streaming-page">
      <header className="viewer-header">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>streamline</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link to="/">Home</Link>
          <Link to="/live">Live now</Link>
          <Link to="/streamer">Creator Studio</Link>
          <Link to="/videos">Videos</Link>
        </nav>
      </header>

      <section className="live-home-page">
        <p className="stream-eyebrow">BROADCAST DETAILS</p>
        <h1>Stream Overview</h1>

        {loading ? (
          <p className="live-list-state" role="status">Loading stream details...</p>
        ) : error ? (
          <p className="live-stream-error" role="alert">{error}</p>
        ) : stream ? (
          <div className="stream-details-container">
            <div className="stream-details-hero">
              <div className="stream-details-thumb-wrap">
                {stream.thumbnailUrl ? (
                  <img src={stream.thumbnailUrl} alt={stream.title} className="stream-details-thumb" />
                ) : (
                  <div className="stream-details-thumb-placeholder">
                    {stream.streamer?.name?.slice(0, 1)?.toUpperCase() || "S"}
                  </div>
                )}
                <span className={`live-status-badge${isLive ? "" : " is-ended"}`}>
                  <span /> {isLive ? "LIVE NOW" : "ENDED"}
                </span>
              </div>

              <div className="stream-details-info">
                <h2 className="stream-details-title">{stream.title}</h2>
                <p className="stream-details-desc">{stream.description || "No description provided."}</p>

                {stream.streamer && (
                  <div className="stream-details-creator-card">
                    {stream.streamer.avatarUrl ? (
                      <img src={stream.streamer.avatarUrl} alt="" className="stream-creator-avatar" />
                    ) : (
                      <div className="stream-creator-avatar-fallback">
                        {stream.streamer.name?.slice(0, 1)?.toUpperCase() || "U"}
                      </div>
                    )}
                    <div>
                      <Link to={`/creators/${stream.streamer.username}`} className="stream-creator-name">
                        {stream.streamer.name}
                      </Link>
                      <span className="stream-creator-handle">@{stream.streamer.username}</span>
                    </div>
                  </div>
                )}

                <div className="stream-details-actions">
                  <Link to={`/viewer/${roomId}`} className="stream-details-watch-btn">
                    {isLive ? "Watch Live Stream" : "Open Watch Page"}
                  </Link>
                  <button type="button" onClick={() => void shareStream()} className="stream-details-share-btn">
                    Share Stream
                  </button>
                  <Link to={`/streamer/analytics/${roomId}`} className="stream-details-analytics-btn">
                    Stream Analytics
                  </Link>
                </div>
                {copied && <p className="stream-copied-notice" role="status">{copied}</p>}
              </div>
            </div>

            <div className="live-stream-grid live-analytics-grid stream-details-grid">
              <article className="live-analytics-card">
                <h2>Current Viewers</h2>
                <p className="live-analytics-value">{isLive ? (stream.viewerCount || 0) : 0}</p>
                <p>Connected active viewer sessions</p>
              </article>
              <article className="live-analytics-card">
                <h2>Peak Concurrent</h2>
                <p className="live-analytics-value">{stream.peakConcurrentViewers || 0}</p>
                <p>Highest simultaneous audience</p>
              </article>
              <article className="live-analytics-card">
                <h2>Total Views</h2>
                <p className="live-analytics-value">{stream.totalViews || 0}</p>
                <p>Total unique viewer sessions</p>
              </article>
              <article className="live-analytics-card">
                <h2>Duration</h2>
                <p className="live-analytics-value">{formatDuration(stream.startedAt, stream.endedAt)}</p>
                <p>Started: {new Date(stream.startedAt).toLocaleTimeString()}</p>
              </article>
            </div>

            <div className="stream-technical-panel">
              <h3>Technical Stream Details</h3>
              <dl className="stream-tech-list">
                <div>
                  <dt>Stream ID</dt>
                  <dd><code>{roomId}</code></dd>
                </div>
                <div>
                  <dt>HLS Playback URL</dt>
                  <dd className="stream-tech-copyable">
                    <code>{stream.playbackUrl}</code>
                    <button type="button" onClick={() => void copyText(stream.playbackUrl, "Playback URL copied!")}>
                      Copy
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd><span className="stream-status-tag">{stream.streamStatus?.toUpperCase()}</span></dd>
                </div>
                <div>
                  <dt>Delivery Protocol</dt>
                  <dd>Low-Latency HLS (HTTP Live Streaming) + WebRTC (WHIP)</dd>
                </div>
              </dl>
            </div>

            <LiveEngagement roomId={roomId} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default StreamDetails;
