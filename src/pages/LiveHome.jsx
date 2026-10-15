import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import "./Streamer.css";
import "./LiveStreaming.css";

function LiveHome() {
  const [streams, setStreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const loadStreams = async () => {
      try {
        const response = await fetch("/api/live", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load live streams.");
        if (active) {
          setStreams(data.streams || []);
          setError("");
        }
      } catch (loadError) {
        console.error("Could not load live streams:", loadError);
        if (active) setError(loadError.message || "Could not load live streams.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadStreams();
    const timer = window.setInterval(() => void loadStreams(), 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="viewer-page live-streaming-page">
      <header className="viewer-header">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>streamline</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link to="/">Home</Link>
          <Link to="/streamer">Streamer dashboard</Link>
          <Link to="/videos">Video library</Link>
        </nav>
      </header>
      <section className="live-home-page">
        <div className="live-home-heading">
          <div>
            <p className="stream-eyebrow">HAPPENING NOW</p>
            <h1>Live streams</h1>
          </div>
          <Link className="live-home-start" to="/streamer">Start your stream</Link>
        </div>
        {loading ? (
          <p className="live-list-state" role="status">Loading live streams...</p>
        ) : error ? (
          <p className="live-stream-error" role="alert">{error}</p>
        ) : streams.length === 0 ? (
          <p className="live-list-state">No one is live right now. Start a broadcast from the creator dashboard.</p>
        ) : (
          <div className="live-stream-grid">
            {streams.map((stream) => (
              <Link className="live-stream-card" to={`/viewer/${stream.roomId}`} key={stream.roomId}>
                <span className="live-stream-card-thumb" aria-hidden="true">
                  {stream.thumbnailUrl && <img src={stream.thumbnailUrl} alt="" loading="lazy" />}
                  {!stream.thumbnailUrl && (stream.streamer?.name?.slice(0, 1)?.toUpperCase() || "S")}
                  <span className="live-status-badge"><span /> LIVE</span>
                </span>
                <span className="live-stream-card-content">
                  <strong>{stream.title}</strong>
                  <span>{stream.streamer?.name || "Creator"} · {stream.viewerCount} watching</span>
                  {stream.description && <span>{stream.description}</span>}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default LiveHome;
