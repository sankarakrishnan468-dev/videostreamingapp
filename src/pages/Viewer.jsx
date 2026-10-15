import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Hls from "hls.js";
import StreamChat from "../components/StreamChat.jsx";
import LiveEngagement from "../components/LiveEngagement.jsx";
import socket from "../services/socket";
import "./Streamer.css";
import "./LiveStreaming.css";

async function readResponse(response, fallback) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) throw new Error(data?.error || `${fallback} (HTTP ${response.status}).`);
  return data;
}

function getViewerSessionId(roomId) {
  const storageKey = `streamline.live-viewer.${roomId}`;
  try {
    const existingId = window.sessionStorage.getItem(storageKey);
    if (existingId && /^[a-f\d-]{36}$/i.test(existingId)) return existingId;
    const sessionId = window.crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, sessionId);
    return sessionId;
  } catch (error) {
    console.warn("Could not persist the viewer session ID:", error);
    return window.crypto.randomUUID();
  }
}

function resolvePlaybackUrl(playbackUrl) {
  if (typeof playbackUrl !== "string" || !playbackUrl.trim()) {
    throw new Error(
      "The backend did not return an HLS playback URL. Check LIVE_HLS_BASE_URL and the MediaMTX HLS server."
    );
  }

  try {
    const resolvedUrl = new URL(playbackUrl, window.location.origin);
    if (!['http:', 'https:'].includes(resolvedUrl.protocol)) {
      throw new Error("Unsupported playback URL protocol.");
    }
    return resolvedUrl.href;
  } catch (urlError) {
    throw new Error(
      "The live stream returned an invalid HLS playback URL. Check LIVE_HLS_BASE_URL and the Vite /hls proxy.",
      { cause: urlError }
    );
  }
}

function Viewer() {
  const { roomId: requestedRoomId } = useParams();
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const sessionIdRef = useRef("");
  const [stream, setStream] = useState(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [status, setStatus] = useState("Connecting to the live stream...");
  const [error, setError] = useState("");
  const [needsPlaybackGesture, setNeedsPlaybackGesture] = useState(false);
  const [joined, setJoined] = useState(false);
  const [recommendedStreams, setRecommendedStreams] = useState([]);

  const enableLiveAudio = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      video.muted = false;
      video.volume = 1;
      await video.play();
      setNeedsPlaybackGesture(false);
      setStatus("LIVE");
    } catch (playError) {
      console.warn("Could not enable live audio:", playError);
      setStatus("Click the video player to enable live audio.");
    }
  };

  useEffect(() => {
    fetch("/api/live", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data?.streams) setRecommendedStreams(data.streams);
      })
      .catch((err) => console.warn("Could not load recommended live streams:", err));
  }, [requestedRoomId]);

  useEffect(() => {
    let active = true;
    let heartbeatTimer;
    let currentRoomId = requestedRoomId || "";
    let joinedSessionId = "";
    let leaveSent = false;

    const stopPlayback = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
      }
    };

    const leaveStream = () => {
      if (!currentRoomId || !joinedSessionId || leaveSent) return;
      leaveSent = true;
      socket.emit("leave-live-room");
      fetch(`/api/live/${currentRoomId}/leave`, {
        method: "POST",
        keepalive: true,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewerSessionId: joinedSessionId })
      }).catch((leaveError) => {
        console.warn("Could not send the live viewer leave event:", leaveError);
      });
    };

    const loadStream = async () => {
      let removePlaybackListeners = () => {};
      try {
        if (!currentRoomId) {
          const activeResponse = await fetch("/api/live/active", { cache: "no-store" });
          const activeData = await readResponse(activeResponse, "There is no live stream right now.");
          currentRoomId = activeData.roomId;
        }
        const [streamResponse] = await Promise.all([
          fetch(`/api/live/${currentRoomId}`, { cache: "no-store" })
        ]);
        const result = await readResponse(streamResponse, "Could not load the live stream.");
        if (!active) return;
        setStream(result.stream);
        setViewerCount(result.stream.viewerCount || 0);
        if (result.stream.streamStatus === "ended") {
          setStatus("This live stream has ended.");
          return;
        }
        const playbackUrl = resolvePlaybackUrl(result.stream.playbackUrl);

        const video = videoRef.current;
        if (!video) return;
        const onPlaying = () => {
          if (active) setStatus("LIVE");
        };
        const onWaiting = () => {
          if (active) setStatus("Stream buffering...");
        };
        const onError = () => {
          if (active) setStatus("Playback interrupted. Reconnecting...");
        };
        video.addEventListener("playing", onPlaying);
        video.addEventListener("waiting", onWaiting);
        video.addEventListener("error", onError);
        removePlaybackListeners = () => {
          video.removeEventListener("playing", onPlaying);
          video.removeEventListener("waiting", onWaiting);
          video.removeEventListener("error", onError);
        };

        // Start muted so browsers that block audible autoplay can still show
        // the live picture. Viewers can enable audio with the player control.
        video.muted = true;
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = playbackUrl;
          video.play().catch((playError) => {
            if (playError.name === "NotAllowedError" && active) {
              setStatus("Stream ready. Press play to start playback.");
            }
          });
        } else if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 30,
            liveSyncDurationCount: 3,
            manifestLoadingMaxRetry: 8,
            levelLoadingMaxRetry: 8
          });
          hlsRef.current = hls;
          hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(playbackUrl));
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch((playError) => {
              if (playError.name === "NotAllowedError") {
                if (active) setNeedsPlaybackGesture(true);
                if (active) setStatus("Stream ready. Press play to start playback.");
              } else {
                console.error("Could not start HLS playback:", playError);
                if (active) setStatus("Stream ready. Press play to start playback.");
              }
            });
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            console.error("Fatal HLS playback error:", data);
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              setStatus("Stream unavailable. Retrying playback...");
              hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              setStatus("Recovering the video decoder...");
              hls.recoverMediaError();
            } else {
              hls.destroy();
              if (active) setStatus("Could not play this live stream.");
            }
          });
          hls.attachMedia(video);
        } else {
          throw new Error("This browser does not support HLS playback.");
        }

        joinedSessionId = getViewerSessionId(currentRoomId);
        sessionIdRef.current = joinedSessionId;
        const joinResponse = await fetch(`/api/live/${currentRoomId}/join`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ viewerSessionId: joinedSessionId })
        });
        const joinedData = await readResponse(joinResponse, "Could not join the live stream.");
        if (!active) {
          removePlaybackListeners();
          leaveStream();
          return;
        }
        leaveSent = false;
        setViewerCount(joinedData.viewerCount);
        setJoined(true);

        const joinChat = () => socket.emit("join-live-room", { roomId: currentRoomId });
        socket.on("connect", joinChat);
        if (socket.connected) joinChat();
        const onCount = (event) => {
          if (event.roomId === currentRoomId && Number.isInteger(event.count)) {
            setViewerCount(event.count);
          }
        };
        const onEnded = (event) => {
          if (event.roomId && event.roomId !== currentRoomId) return;
          setStatus("This live stream has ended.");
          setJoined(false);
          window.clearInterval(heartbeatTimer);
          leaveStream();
          stopPlayback();
        };
        socket.on("live-viewer-count", onCount);
        socket.on("live-stream-ended", onEnded);

        const heartbeat = async () => {
          try {
            const response = await fetch(`/api/live/${currentRoomId}/join`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ viewerSessionId: joinedSessionId })
            });
            const data = await readResponse(response, "Could not refresh the live viewer session.");
            if (active) setViewerCount(data.viewerCount);
          } catch (heartbeatError) {
            if (!active) return;
            console.error("Could not refresh live viewer session:", heartbeatError);
            setStatus("Viewer session interrupted. Reconnecting...");
          }
        };
        heartbeatTimer = window.setInterval(() => void heartbeat(), joinedData.heartbeatIntervalMs || 20000);

        return () => {
          socket.off("connect", joinChat);
          socket.off("live-viewer-count", onCount);
          socket.off("live-stream-ended", onEnded);
          removePlaybackListeners();
        };
      } catch (loadError) {
        removePlaybackListeners();
        if (!active) return;
        console.error("Could not connect to live playback:", loadError);
        setError(loadError.message || "Could not connect to the live stream.");
        setStatus(loadError.message || "Could not connect to the live stream.");
      }
    };

    let removeStreamListeners;
    void loadStream().then((cleanup) => {
      removeStreamListeners = cleanup;
    });
    const onBeforeUnload = () => leaveStream();
    window.addEventListener("pagehide", onBeforeUnload);
    return () => {
      active = false;
      window.clearInterval(heartbeatTimer);
      window.removeEventListener("pagehide", onBeforeUnload);
      removeStreamListeners?.();
      leaveStream();
      stopPlayback();
    };
  }, [requestedRoomId]);

  const shareStream = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: stream?.title || "Live stream", url: window.location.href });
      } else {
        await navigator.clipboard.writeText(window.location.href);
        setError("");
        setStatus("Viewer link copied.");
      }
    } catch (shareError) {
      if (shareError.name !== "AbortError") {
        console.error("Could not share the live stream:", shareError);
        setError("Could not share this stream. Copy the URL from your address bar.");
      }
    }
  };

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
          <Link to="/streamer">Streamer</Link>
        </nav>
      </header>
      <section className="viewer-main">
        <div className="viewer-title live-watch-title">
          <p className="stream-eyebrow">LIVE BROADCAST</p>
          <h1>{stream?.title || "Live stream"}</h1>
          <p className="live-watch-description">{stream?.description}</p>
          {stream?.streamer && (
            <p className="live-watch-creator">
              {stream.streamer.name} · @{stream.streamer.username}
            </p>
          )}
          <div className="live-watch-meta">
            <span className={`live-status-badge${stream?.streamStatus === "ended" ? " is-ended" : ""}`}>
              <span /> {stream?.streamStatus === "ended" ? "ENDED" : "LIVE"}
            </span>
            <span aria-label="Concurrent viewers">{viewerCount} watching</span>
            <button type="button" onClick={() => void shareStream()}>Share live stream</button>
            {stream?.roomId && (
              <Link to={`/stream/${stream.roomId}`} className="live-share-details-link">
                Stream details
              </Link>
            )}
          </div>
        </div>
        <div className="viewer-layout">
          <section className="viewer-player-panel live-hls-player" aria-label="Live video">
            <video ref={videoRef} autoPlay muted playsInline controls />
            {needsPlaybackGesture && (
              <button type="button" className="live-audio-btn" onClick={() => void enableLiveAudio()}>
                Enable audio
              </button>
            )}
            {status !== "LIVE" && (
              <p className="live-playback-status" role="status">{status}</p>
            )}
          </section>
          <StreamChat role="Viewer" roomId={joined ? stream?.roomId : ""} />
        </div>
        {error && <p className="live-stream-error" role="alert">{error}</p>}
        {stream?.roomId && <LiveEngagement roomId={stream.roomId} />}

        {recommendedStreams.filter((s) => s.roomId !== (stream?.roomId || requestedRoomId)).length > 0 && (
          <section className="recommended-live-section">
            <h2 className="recommended-live-heading">Recommended Live Streams</h2>
            <div className="live-stream-grid">
              {recommendedStreams
                .filter((s) => s.roomId !== (stream?.roomId || requestedRoomId))
                .slice(0, 4)
                .map((rec) => (
                  <Link className="live-stream-card" to={`/viewer/${rec.roomId}`} key={rec.roomId}>
                    <span className="live-stream-card-thumb" aria-hidden="true">
                      {rec.thumbnailUrl && <img src={rec.thumbnailUrl} alt="" loading="lazy" />}
                      {!rec.thumbnailUrl && (rec.streamer?.name?.slice(0, 1)?.toUpperCase() || "S")}
                      <span className="live-status-badge"><span /> LIVE</span>
                    </span>
                    <span className="live-stream-card-content">
                      <strong>{rec.title}</strong>
                      <span>{rec.streamer?.name || "Creator"} · {rec.viewerCount || 0} watching</span>
                      {rec.description && <span>{rec.description}</span>}
                    </span>
                  </Link>
                ))}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

export default Viewer;
