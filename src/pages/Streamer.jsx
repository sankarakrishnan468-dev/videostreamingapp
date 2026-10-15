import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import StreamChat from "../components/StreamChat.jsx";
import { publishWhip } from "../services/liveWhip.js";
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

  if (!response.ok) {
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new Error(
        "The app backend is not responding. Check the Vite terminal for backend startup errors, then confirm MongoDB is reachable and restart the app."
      );
    }

    throw new Error(
      data?.error || `${fallback} (HTTP ${response.status}).`
    );
  }

  return data;
}

function Streamer() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const publisherRef = useRef(null);
  const streamDataRef = useRef(null);
  const reconnectRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectCountRef = useRef(0);
  const publishAttemptRef = useRef(false);

  const [streamData, setStreamData] = useState(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [status, setStatus] = useState(
    "Set your stream details, then start broadcasting."
  );
  const [connected, setConnected] = useState(false);
  const [working, setWorking] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [peakViewers, setPeakViewers] = useState(0);
  const [totalViews, setTotalViews] = useState(0);
  const [publisherKey, setPublisherKey] = useState("");
  const [error, setError] = useState("");
  const [facingMode, setFacingMode] = useState("user");
  const [isMuted, setIsMuted] = useState(false);
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  const [keyCopied, setKeyCopied] = useState(false);
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] =
    useState("");
  const [activeAudioLabel, setActiveAudioLabel] = useState("");

  const saveStreamData = (data) => {
    streamDataRef.current = data;
    setStreamData(data);
    setTitle(data.title || "");
    setDescription(data.description || "");
    setThumbnailUrl(data.thumbnailUrl || "");
  };

  const refreshAudioDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];

      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(
        (device) => device.kind === "audioinput"
      );

      setAudioDevices(inputs);
      return inputs;
    } catch (deviceError) {
      console.warn("Could not list audio devices:", deviceError);
      return [];
    }
  }, []);

  // Replace the current audio track and keep the local preview stream in sync.
  // The caller will republish if a new audio track needs WHIP renegotiation.
  const replaceAudioTrack = useCallback(async (newTrack) => {
    const media = streamRef.current;

    if (!media || !newTrack) {
      throw new Error("Camera stream or audio track is unavailable.");
    }

    const publisher = publisherRef.current;
    const peer = publisher?.peer;

    const audioSender =
      publisher?.audioSender ||
      peer?.getSenders().find(
        (sender) => sender.track?.kind === "audio"
      );

    if (audioSender) {
      try {
        await audioSender.replaceTrack(newTrack);
      } catch (replaceError) {
        newTrack.stop();
        throw new Error(
          `Could not replace the publisher audio track: ${replaceError.message}`,
          { cause: replaceError }
);
      }
    }

    // Update the local MediaStream only after the sender accepts the track.
    const oldTracks = media.getAudioTracks();

    oldTracks.forEach((track) => {
      media.removeTrack(track);
    });

    media.addTrack(newTrack);

    // A newly captured track can inherit a disabled state in some browsers.
    // Keep the track enabled unless the user explicitly mutes it later.
    newTrack.enabled = true;

    // Stop old microphone/system-audio tracks only after replacement.
    oldTracks.forEach((track) => {
      if (track !== newTrack) track.stop();
    });

    setIsMuted(false);

    if (videoRef.current && videoRef.current.srcObject !== media) {
      videoRef.current.srcObject = media;
    }

    return {
      hasSender: Boolean(audioSender),
      hadPublisher: Boolean(publisher),
    };
  }, []);

  const getCamera = useCallback(
    async (targetFacingMode = facingMode) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Camera and microphone access requires HTTPS or localhost in a supported browser."
        );
      }

      let combinedStream;
      let videoStream;
      let audioStream;
      let microphoneError;

      try {
        // Request both devices together first. Some mobile browsers behave
        // better when camera and microphone are opened in one capture request.
        combinedStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: targetFacingMode },
          audio: true,
        });
      } catch {
        try {
          videoStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: targetFacingMode },
          });
        } catch {
          try {
            videoStream = await navigator.mediaDevices.getUserMedia({
              video: true,
            });
          } catch (cameraError) {
            if (
              cameraError.name === "NotAllowedError" ||
              cameraError.name === "SecurityError"
            ) {
              throw new Error(
                "Camera permission was denied. Allow camera access for this site and try again.",
                { cause: cameraError }
              );
            }

            if (
              cameraError.name === "NotFoundError" ||
              cameraError.name === "DevicesNotFoundError"
            ) {
              throw new Error(
                "No camera was found. Connect a camera or webcam and try again.",
                { cause: cameraError }
              );
            }

            if (cameraError.name === "NotReadableError") {
              throw new Error(
                "The camera is busy. Close other apps using it and try again.",
                { cause: cameraError }
              );
            }

            throw new Error(
              "Could not open the camera. Check browser permissions and device settings.",
              { cause: cameraError }
            );
          }
        }

        // Preserve video-only preview when no microphone is available, while
        // still trying audio independently in case the combined request failed
        // only because of a camera constraint.
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          microphoneError = null;
        } catch (audioError) {
          microphoneError = audioError;
        }
      }

      const media = new MediaStream([
        ...(combinedStream?.getTracks() || []),
        ...(videoStream?.getVideoTracks() || []),
        ...(audioStream?.getAudioTracks() || []),
      ]);

      const currentAudio = media.getAudioTracks()[0];

      setActiveAudioLabel(currentAudio?.label || "");
      setSelectedAudioDeviceId(
        currentAudio?.getSettings()?.deviceId || ""
      );
      setIsMuted(false);

      if (microphoneError) {
        const name = microphoneError.name;

        const microphoneMissing =
          name === "NotFoundError" || name === "DevicesNotFoundError";

        const message =
          name === "NotAllowedError" || name === "SecurityError"
            ? "Microphone permission was denied. Allow access, then click Connect Mic."
            : name === "NotFoundError" ||
                name === "DevicesNotFoundError"
              ? "No microphone was found. Connect or enable a microphone, then allow access in your browser settings."
              : name === "NotReadableError"
                ? "The microphone is busy. Close other apps using it, then click Connect Mic."
                : "Could not open the microphone. Check browser permissions, then click Connect Mic.";

        // A missing microphone is a supported video-only configuration. Keep
        // it out of the error banner so starting a video stream is not
        // blocked by an optional input device.
        if (microphoneMissing) {
          setError("");
          setStatus(
            "No microphone detected. Video-only preview is ready; connect a mic or use system audio if needed."
          );
        } else {
          setError(message);
        }
      } else {
        setError("");
      }

      // Stop old local tracks once the new camera stream is ready.
      const oldMedia = streamRef.current;
      streamRef.current = media;

      if (videoRef.current) {
        videoRef.current.srcObject = media;
        await videoRef.current.play().catch(() => {});
      }

      oldMedia?.getTracks().forEach((track) => track.stop());

      for (const track of media.getVideoTracks()) {
        track.addEventListener(
          "ended",
          () => {
            if (streamRef.current !== media) return;

            setConnected(false);
            setStatus(
              "Camera disconnected. Requesting a new camera connection..."
            );

            window.clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = window.setTimeout(() => {
              void reconnectRef.current?.();
            }, 1500);
          },
          { once: true }
        );
      }

      void refreshAudioDevices();
      return media;
    },
    [facingMode, refreshAudioDevices]
  );

  const publishToStream = useCallback(
    async (renewCredentials = false) => {
      if (publishAttemptRef.current) return;

      publishAttemptRef.current = true;
      window.clearTimeout(reconnectTimerRef.current);
      setWorking(true);
      setError("");

      try {
        const data = streamDataRef.current;

        if (!data) {
          throw new Error(
            "Start a stream before connecting the broadcast."
          );
        }

        if (!streamRef.current) {
          await getCamera();
        }

        if (publisherRef.current) {
          const previous = publisherRef.current;
          publisherRef.current = null;

          await previous.close().catch((closeError) => {
            console.warn(
              "Could not close the previous WHIP session:",
              closeError
            );
          });
        }

        let key = publisherKey;
        let whipUrl = data.whipUrl;

        if (renewCredentials || !key) {
          const response = await fetch(
            `/api/live/${data.roomId}/publish-credentials`,
            {
              method: "POST",
              credentials: "include",
            }
          );

          const credentials = await readResponse(
            response,
            "Could not renew publishing credentials."
          );

          key = credentials.publisherKey;
          whipUrl = credentials.whipUrl;
          setPublisherKey(key);
        }

        if (!whipUrl || !key) {
          throw new Error(
            "The backend did not provide secure broadcast credentials."
          );
        }

        setStatus("Connecting to the live video server...");

        const publisher = await publishWhip(
          streamRef.current,
          whipUrl,
          key,
          (connectionState) => {
            if (connectionState === "connected") {
              reconnectCountRef.current = 0;
              setConnected(true);

              if (streamRef.current?.getAudioTracks().length) {
                setStatus("Broadcast connected. Your stream is live.");
                setError("");
              } else {
                setStatus(
                  "Broadcast connected without a microphone. Connect Mic to add audio."
                );
                setError(
                  "Your stream is live, but no microphone is connected."
                );
              }
            } else if (connectionState === "connecting") {
              setConnected(false);
              setStatus("Connecting to the live video server...");
            } else if (
              connectionState === "disconnected" ||
              connectionState === "failed"
            ) {
              setConnected(false);
              setStatus("Broadcast connection lost. Reconnecting...");

              window.clearTimeout(reconnectTimerRef.current);
              reconnectTimerRef.current = window.setTimeout(() => {
                void reconnectRef.current?.();
              }, connectionState === "failed" ? 1000 : 4000);
            }
          }
        );

        publisherRef.current = publisher;
        setPublisherKey(key);
      } catch (publishError) {
        console.error("Could not publish the live stream:", publishError);
        setConnected(false);

        const friendlyMessage =
          publishError.message === "Failed to fetch"
            ? "Could not connect to MediaMTX on port 8889. Make sure MediaMTX is installed and running."
            : publishError.message || "Could not connect to the video server.";

        setError(friendlyMessage);
        setStatus("Broadcast connection failed.");

        if (streamDataRef.current && reconnectCountRef.current < 5) {
          reconnectCountRef.current += 1;

          const delay = Math.min(
            1000 * 2 ** reconnectCountRef.current,
            30000
          );

          reconnectTimerRef.current = window.setTimeout(() => {
            void reconnectRef.current?.();
          }, delay);

          setStatus(
            `Connection interrupted. Retrying in ${Math.round(delay / 1000)} seconds...`
          );
        }
      } finally {
        publishAttemptRef.current = false;
        setWorking(false);
      }
    },
    [getCamera, publisherKey]
  );

  const connectMicrophone = async (deviceId, { optional = false } = {}) => {
    setWorking(true);
    setError("");

    let micStream;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access requires HTTPS or localhost."
        );
      }

      if (!streamRef.current) {
        await getCamera();
      }

      const availableInputs = await refreshAudioDevices();

      // Ignore a device ID if the device has disappeared.
      const currentDeviceId =
        deviceId &&
        availableInputs.some(
          (device) => device.deviceId === deviceId
        )
          ? deviceId
          : "";

      if (currentDeviceId) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: currentDeviceId } },
          });
        } catch (deviceError) {
          // A device can disappear after enumerateDevices() (USB/Bluetooth
          // disconnects and browser permission changes both cause this). Do
          // not leave audio unusable; fall back to the current default input.
          if (
            deviceError.name !== "NotFoundError" &&
            deviceError.name !== "DevicesNotFoundError" &&
            deviceError.name !== "OverconstrainedError"
          ) {
            throw deviceError;
          }

          setSelectedAudioDeviceId("");
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
        }
      } else {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
      }

      const newTrack = micStream.getAudioTracks()[0];

      if (!newTrack) {
        throw new Error("No microphone audio track was returned.");
      }

      // Keep only the selected audio track; the video stays in streamRef.
      const result = await replaceAudioTrack(newTrack);

      // The new microphone may not have an RTP sender if the original
      // WHIP session started without audio. Re-publish to negotiate audio.
      // If WHIP already has an audio sender, replaceTrack() updates the
      // broadcast in place. Reconnecting here can detach the just-installed
      // track while the old WHIP session is being closed. Only renegotiate
      // when the original video-only session had no usable audio sender.
      if (connected && result.hadPublisher && !result.hasSender) {
        setStatus("Connecting microphone to the live broadcast...");
        await publishToStream(true);
      }

      const activeId = newTrack.getSettings()?.deviceId || currentDeviceId || "";

      setSelectedAudioDeviceId(activeId);
      setActiveAudioLabel(newTrack.label || "Microphone");
      setIsMuted(false);
      setStatus(
        connected
          ? "Microphone connected. Check the viewer page for audio."
          : `Microphone connected: ${newTrack.label || "Audio active"}`
      );

      await refreshAudioDevices();
    } catch (err) {
      // Stop any captured tracks if the operation failed before installing
      // the new microphone in the main stream.
      micStream?.getTracks().forEach((track) => {
        if (!streamRef.current?.getTracks().includes(track)) {
          track.stop();
        }
      });

      const noMicrophone =
        err.name === "NotFoundError" ||
        err.name === "DevicesNotFoundError";

      console.warn("Could not connect microphone:", err);

      setError(
        optional
          ? ""
          : noMicrophone
          ? "No microphone hardware found. Connect a microphone or use System / Tab Audio."
          : err.name === "NotAllowedError" ||
              err.name === "SecurityError"
            ? "Microphone access is blocked in browser permissions or Windows Privacy Settings."
            : err.message || "Could not connect to microphone."
      );

      if (noMicrophone) {
        setStatus(
          optional
            ? "No microphone detected. Starting video-only broadcast."
            : "No microphone detected. Video streaming can continue without mic audio."
        );
      }
    } finally {
      setWorking(false);
    }
  };

  const connectSystemAudio = async () => {
    setWorking(true);
    setError("");

    let displayStream;

    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error(
          "System audio capture is not supported by this browser."
        );
      }

      // The browser needs video: true to show the share picker.
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const systemAudioTrack = displayStream.getAudioTracks()[0];

      displayStream.getVideoTracks().forEach((track) => track.stop());

      if (!systemAudioTrack) {
        throw new Error(
          "No system audio was selected. Choose a browser tab or window with audio enabled."
        );
      }

      if (!streamRef.current) {
        await getCamera();
      }

      const result = await replaceAudioTrack(systemAudioTrack);

      // An existing WHIP audio sender is updated by replaceTrack(). A fresh
      // publish is required only when the session started without one.
      if (connected && result.hadPublisher && !result.hasSender) {
        setStatus("Connecting system audio to the live broadcast...");
        await publishToStream(true);
      }

      setSelectedAudioDeviceId("");
      setActiveAudioLabel(
        `System audio${systemAudioTrack.label ? `: ${systemAudioTrack.label}` : ""}`
      );
      setIsMuted(false);
      setStatus("System audio connected.");

      await refreshAudioDevices();

      systemAudioTrack.addEventListener(
        "ended",
        () => {
          if (
            streamRef.current?.getAudioTracks().includes(systemAudioTrack)
          ) {
            setActiveAudioLabel("");
            setStatus(
              "System audio sharing stopped. Connect a microphone or share audio again."
            );
          }
        },
        { once: true }
      );
    } catch (err) {
      displayStream?.getTracks().forEach((track) => track.stop());
      console.warn("Could not connect system audio:", err);

      if (err.name !== "AbortError" && err.name !== "NotAllowedError") {
        setError(err.message || "Could not connect system audio.");
      }
    } finally {
      setWorking(false);
    }
  };

  const flipCamera = async () => {
    const nextMode = facingMode === "user" ? "environment" : "user";

    setFacingMode(nextMode);
    setWorking(true);

    try {
      await getCamera(nextMode);

      if (connected && publisherRef.current) {
        await publishToStream(false);
      }
    } catch (flipError) {
      setError(flipError.message || "Could not switch camera.");
    } finally {
      setWorking(false);
    }
  };

  const toggleMic = () => {
    const audioTracks = streamRef.current?.getAudioTracks() || [];

    if (!audioTracks.length) {
      setError("No audio track is connected. Click Connect Mic first.");
      return;
    }

    const nextMuted = !isMuted;

    audioTracks.forEach((track) => {
      track.enabled = !nextMuted;
    });

    setIsMuted(nextMuted);
    setStatus(nextMuted ? "Microphone muted." : "Microphone active.");
    setError("");
  };

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return undefined;

    const onDeviceChange = () => void refreshAudioDevices();

    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        onDeviceChange
      );
    };
  }, [refreshAudioDevices]);

  const copyPublisherKey = async () => {
    if (!publisherKey) return;

    try {
      await navigator.clipboard.writeText(publisherKey);
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      setKeyCopied(false);
    }
  };

  const formatUptime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    return `${h.toString().padStart(2, "0")}:${m
      .toString()
      .padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (!streamData?.roomId) return undefined;

    const onCount = (event) => {
      if (
        event.roomId === streamData.roomId &&
        Number.isInteger(event.count)
      ) {
        setViewerCount(event.count);
        setPeakViewers((previous) =>
          Math.max(previous, event.count)
        );
      }
    };

    socket.emit("join-live-room", {
      roomId: streamData.roomId,
      role: "streamer",
    });

    socket.on("live-viewer-count", onCount);

    return () => {
      socket.off("live-viewer-count", onCount);
      socket.emit("leave-live-room");
    };
  }, [streamData?.roomId]);

  useEffect(() => {
    if (!connected || !streamData?.startedAt) return undefined;

    const startTime = new Date(streamData.startedAt).getTime();

    const timer = window.setInterval(() => {
      setUptimeSeconds(
        Math.max(0, Math.floor((Date.now() - startTime) / 1000))
      );
    }, 1000);

    return () => window.clearInterval(timer);
  }, [connected, streamData?.startedAt]);

  useEffect(() => {
    reconnectRef.current = () => publishToStream(true);
  }, [publishToStream]);

  useEffect(() => {
    let active = true;
    const previewVideo = videoRef.current;

    fetch("/api/live/mine", { credentials: "include" })
      .then((response) =>
        readResponse(response, "Could not load your stream.")
      )
      .then(({ stream }) => {
        if (!active || !stream) return;

        saveStreamData(stream);
        setStatus(
          "Your live stream is ready. Reconnect your camera to resume broadcasting."
        );
        setViewerCount(stream.viewerCount || 0);
        setPeakViewers(stream.peakConcurrentViewers || 0);
        setTotalViews(stream.totalViews || 0);
      })
      .catch((loadError) => {
        if (!active || loadError.message.includes("401")) return;

        console.error("Could not load the stream dashboard:", loadError);
        setError(loadError.message || "Could not load your live stream.");
      });

    return () => {
      active = false;
      window.clearTimeout(reconnectTimerRef.current);

      publisherRef.current?.close().catch((closeError) => {
        console.warn("Could not close the WHIP session:", closeError);
      });

      const media = streamRef.current;
      streamRef.current = null;

      media?.getTracks().forEach((track) => track.stop());

      if (previewVideo) previewVideo.srcObject = null;
    };
  }, []);

  useEffect(() => {
    if (!streamData?.roomId) return undefined;

    let active = true;

    const refreshStats = async () => {
      try {
        const response = await fetch(
          `/api/live/${streamData.roomId}/stats`,
          {
            credentials: "include",
            cache: "no-store",
          }
        );

        const stats = await readResponse(
          response,
          "Could not load stream analytics."
        );

        if (!active) return;

        setViewerCount(stats.viewerCount);
        setPeakViewers(stats.peakConcurrentViewers);
        setTotalViews(stats.totalViews);
      } catch (statsError) {
        if (active) {
          console.error(
            "Could not refresh live-stream statistics:",
            statsError
          );
        }
      }
    };

    void refreshStats();

    const timer = window.setInterval(() => {
      void refreshStats();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [streamData?.roomId]);

  const startLive = async (event) => {
    event.preventDefault();
    setWorking(true);
    setError("");

    try {
      await getCamera();

      // Microphone audio is optional. Retry it during the user-initiated
      // action, but keep the video-only fallback when no mic is available.
      if (!streamRef.current?.getAudioTracks().length) {
        setStatus("Requesting microphone access...");
        await connectMicrophone("", { optional: true });
      }

      const response = await fetch("/api/live/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, thumbnailUrl }),
      });

      const data = await readResponse(
        response,
        "Could not start the live stream."
      );

      saveStreamData(data);
      setPublisherKey(data.publisherKey);
      reconnectCountRef.current = 0;

      await publishToStream(false);
    } catch (startError) {
      console.error("Could not start a live stream:", startError);
      setError(startError.message || "Could not start the live stream.");
      setStatus("Stream setup failed.");

      if (!streamDataRef.current) {
        const media = streamRef.current;
        streamRef.current = null;
        media?.getTracks().forEach((track) => track.stop());
      }
    } finally {
      setWorking(false);
    }
  };

  const reconnectBroadcast = async () => {
    setWorking(true);
    setError("");

    try {
      if (!streamRef.current) await getCamera();

      if (!streamRef.current?.getAudioTracks().length) {
        setStatus("Requesting microphone access...");
        await connectMicrophone("", { optional: true });
      }

      reconnectCountRef.current = 0;
      await publishToStream(true);
    } catch (reconnectError) {
      console.error("Could not reconnect the broadcast:", reconnectError);
      setError(
        reconnectError.message || "Could not reconnect the broadcast."
      );
    } finally {
      setWorking(false);
    }
  };

  const stopLive = async () => {
    const currentStream = streamDataRef.current;
    if (!currentStream) return;

    setWorking(true);
    setError("");
    window.clearTimeout(reconnectTimerRef.current);

    try {
      const response = await fetch(
        `/api/live/${currentStream.roomId}/end`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      await readResponse(response, "Could not end the live stream.");

      const publisher = publisherRef.current;
      publisherRef.current = null;
      await publisher?.close();

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;

      if (videoRef.current) videoRef.current.srcObject = null;

      saveStreamData({ ...currentStream, streamStatus: "ended" });
      setPublisherKey("");
      setConnected(false);
      setViewerCount(0);
      setActiveAudioLabel("");
      setSelectedAudioDeviceId("");
      setStatus("Live stream ended.");
    } catch (stopError) {
      console.error("Could not end the live stream:", stopError);
      setError(stopError.message || "Could not end the live stream.");
    } finally {
      setWorking(false);
    }
  };

  const copyStreamLink = async () => {
    if (!streamData?.roomId) return;

    const url = new URL(
      `/viewer/${streamData.roomId}`,
      window.location.origin
    ).href;

    try {
      await navigator.clipboard.writeText(url);
      setStatus("Viewer link copied.");
    } catch (copyError) {
      console.error("Could not copy viewer link:", copyError);
      setError("Could not copy the link. Copy it from the address bar: " + url);
    }
  };

  const isLive =
    streamData?.streamStatus !== "ended" && Boolean(streamData);

  return (
    <main className="stream-page live-streaming-page">
      <header className="stream-page-header">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>streamline</span>
        </Link>

        <nav aria-label="Main navigation">
          <Link to="/">Home</Link>
          <Link to="/live">Live now</Link>
          <Link to="/videos">Video library</Link>
        </nav>
      </header>

      <section className="stream-main">
        <div className="stream-heading">
          <p className="stream-eyebrow">CREATOR STUDIO</p>
          <h1>Go live</h1>
          <p>
            Broadcast your camera through WHIP. Video is delivered to viewers
            over HLS.
          </p>
        </div>

        <div className="stream-layout live-dashboard-layout">
          <section className="stream-player-panel">
            <div className="stream-preview-frame">
              <video
                ref={videoRef}
                className="stream-preview"
                muted
                autoPlay
                playsInline
              />

              {isLive && (
                <span
                  className={`live-status-badge${
                    connected ? "" : " is-reconnecting"
                  }`}
                >
                  <span />
                  {connected
                    ? `LIVE · ${formatUptime(uptimeSeconds)}`
                    : "RECONNECTING"}
                </span>
              )}

              <div className="streamer-media-toolbar">
                <button
                  type="button"
                  className="streamer-tool-btn"
                  onClick={() => void flipCamera()}
                  disabled={working}
                  title="Switch between front and rear cameras"
                >
                  Flip Camera ({facingMode === "user" ? "Front" : "Back"})
                </button>

                <button
                  type="button"
                  className={`streamer-tool-btn${
                    isMuted ? " is-muted" : ""
                  }`}
                  onClick={toggleMic}
                  title="Toggle microphone"
                >
                  {isMuted ? "Unmute Mic" : "Mute Mic"}
                </button>
              </div>
            </div>

            <div className="live-dashboard-body">
              <div className="live-dashboard-status" role="status">
                <span
                  className={
                    connected
                      ? "live-connection-dot is-connected"
                      : "live-connection-dot"
                  }
                />
                {status}
              </div>

              <div className="live-audio-studio-card">
                <div className="live-audio-header">
                  <h3 className="live-audio-title">
                    <span>🎙️ Audio Controls &amp; Input</span>
                  </h3>

                  <span
                    className={`live-audio-status-pill ${
                      activeAudioLabel ? "is-active" : "is-fallback"
                    }`}
                  >
                    {activeAudioLabel
                      ? `🟢 Mic: ${activeAudioLabel}`
                      : "No microphone connected"}
                  </span>
                </div>

                <div className="live-audio-controls-row">
                  <select
                    className="live-audio-select"
                    value={selectedAudioDeviceId}
                    onChange={(event) =>
                      void connectMicrophone(event.target.value)
                    }
                    disabled={working}
                    title="Select microphone device"
                  >
                    <option value="">
                      {audioDevices.length > 0
                        ? "Default Microphone"
                        : "No Microphone Found"}
                    </option>

                    {audioDevices.map((device, index) => (
                      <option
                        key={device.deviceId || index}
                        value={device.deviceId}
                      >
                        {device.label || `Microphone ${index + 1}`}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    className="live-audio-btn"
                    onClick={() =>
                      void connectMicrophone(selectedAudioDeviceId)
                    }
                    disabled={working}
                    title="Connect or retry microphone"
                  >
                    Connect Mic
                  </button>

                  <button
                    type="button"
                    className="live-audio-btn is-system"
                    onClick={() => void connectSystemAudio()}
                    disabled={working}
                    title="Share audio from a browser tab or window"
                  >
                    Use System / Tab Audio
                  </button>
                </div>

                {!activeAudioLabel && (
                  <p className="live-audio-hint">
                    No microphone detected? You can start video-only, or use
                    “Use System / Tab Audio” to add audio. Connect a microphone
                    only if you want live mic audio.
                  </p>
                )}
              </div>

              {streamData?.roomId && (
                <div className="live-share-row">
                  <Link to={`/viewer/${streamData.roomId}`}>
                    Open watch page
                  </Link>
                  <Link to={`/stream/${streamData.roomId}`}>
                    View stream details
                  </Link>
                  <button
                    type="button"
                    onClick={() => void copyStreamLink()}
                  >
                    Copy viewer link
                  </button>
                </div>
              )}

              {isLive ? (
                <div className="live-dashboard-controls">
                  {!connected && (
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void reconnectBroadcast()}
                    >
                      {working ? "Connecting..." : "Reconnect broadcast"}
                    </button>
                  )}

                  <button
                    type="button"
                    className="live-stop-button"
                    disabled={working}
                    onClick={() => void stopLive()}
                  >
                    {working ? "Please wait..." : "Stop live"}
                  </button>
                </div>
              ) : (
                <form
                  className="live-details-form"
                  onSubmit={(event) => void startLive(event)}
                >
                  <label>
                    Stream title
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      maxLength={120}
                      required
                      placeholder="What are you streaming?"
                    />
                  </label>

                  <label>
                    Description
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      maxLength={2000}
                      rows={3}
                      placeholder="Tell viewers what to expect"
                    />
                  </label>

                  <label>
                    Thumbnail image URL (HTTPS)
                    <input
                      type="url"
                      value={thumbnailUrl}
                      onChange={(event) => setThumbnailUrl(event.target.value)}
                      maxLength={2048}
                      placeholder="https://example.com/stream-thumbnail.jpg"
                    />
                  </label>

                  <button type="submit" disabled={working}>
                    {working ? "Starting..." : "Start live"}
                  </button>
                </form>
              )}

              {publisherKey && isLive && (
                <details className="live-publisher-details">
                  <summary>Secure publisher credential (Stream Key)</summary>
                  <p>
                    Private: do not share this credential publicly. It is used
                    to securely ingest the broadcast.
                  </p>

                  <div className="stream-key-row">
                    <code>{publisherKey}</code>
                    <button
                      type="button"
                      onClick={() => void copyPublisherKey()}
                      className="stream-key-copy-btn"
                    >
                      {keyCopied ? "Copied!" : "Copy Stream Key"}
                    </button>
                  </div>
                </details>
              )}

              {error && (
                <p className="live-stream-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </section>

          <aside className="live-dashboard-sidebar">
            <section className="live-analytics-card">
              <h2>Live analytics</h2>

              {streamData?.roomId && (
                <Link
                  className="live-analytics-link"
                  to={`/streamer/analytics/${streamData.roomId}`}
                >
                  Open full stream analytics
                </Link>
              )}

              <dl>
                <div>
                  <dt>Stream health</dt>
                  <dd>
                    {connected ? "Healthy (WHIP WebRTC)" : "Connecting / Idle"}
                  </dd>
                </div>
                <div>
                  <dt>Concurrent viewers</dt>
                  <dd>{viewerCount}</dd>
                </div>
                <div>
                  <dt>Peak concurrent</dt>
                  <dd>{peakViewers}</dd>
                </div>
                <div>
                  <dt>Total views</dt>
                  <dd>{totalViews}</dd>
                </div>
              </dl>

              <p>
                Concurrent viewers are active browser sessions with a recent
                playback heartbeat. Total views count distinct sessions.
              </p>
            </section>

            <StreamChat
              role="Streamer"
              roomId={streamData?.roomId || ""}
            />
          </aside>
        </div>
      </section>
    </main>
  );
}

export default Streamer;
