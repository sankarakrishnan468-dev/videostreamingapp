import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import socket, { socketConfigured } from "../services/socket";
import "./PrivateCall.css";

const ROOM_ID_PATTERN = /^[a-f\d]{32}$/i;

async function getCallMedia(mediaDevices) {
  try {
    return await mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (combinedError) {
    if (!["NotFoundError", "OverconstrainedError", "NotReadableError"].includes(combinedError.name)) {
      throw combinedError;
    }

    const tracks = [];
    const errors = [];

    for (const constraints of [
      { audio: true, video: false },
      { audio: false, video: true }
    ]) {
      try {
        const stream = await mediaDevices.getUserMedia(constraints);
        tracks.push(...stream.getTracks());
      } catch (error) {
        errors.push(error);
      }
    }

    if (tracks.length > 0) {
      return new MediaStream(tracks);
    }

    const mediaError = new Error("No usable camera or microphone was found.");
    mediaError.name = errors.every((error) => error.name === "NotFoundError")
      ? "NoMediaDevicesError"
      : errors.find((error) => error.name !== "NotFoundError")?.name || combinedError.name;
    throw mediaError;
  }
}

function PrivateCall() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerRef = useRef(null);
  const micEnabledRef = useRef(true);
  const cameraEnabledRef = useRef(true);
  const pendingCandidatesRef = useRef([]);
  const pendingOfferRef = useRef(null);
  const peerPresentRef = useRef(false);
  const mediaUnavailableRef = useRef(false);
  const shouldOfferRef = useRef(false);
  const offerStartedRef = useRef(false);
  const initialStatus = !socketConfigured
    ? "Backend URL is not configured. Set VITE_SOCKET_URL and restart the app."
    : !ROOM_ID_PATTERN.test(roomId || "")
      ? "This call link is invalid."
      : !navigator.mediaDevices?.getUserMedia
        ? "This browser cannot access camera and microphone. Use localhost or HTTPS."
        : "Preparing your call...";
  const [status, setStatus] = useState(initialStatus);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [copied, setCopied] = useState(false);
  const [roomFull, setRoomFull] = useState(false);
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const [hasCamera, setHasCamera] = useState(false);

  useEffect(() => {
    if (!socketConfigured || !ROOM_ID_PATTERN.test(roomId || "")) {
      return undefined;
    }

    let active = true;

    const closePeer = () => {
      peerRef.current?.close();
      peerRef.current = null;
      pendingCandidatesRef.current = [];
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    };

    const addLocalTracks = (peer) => {
      localStreamRef.current?.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current);
      });
    };

    const createPeerConnection = () => {
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      });

      peerRef.current = peer;
      addLocalTracks(peer);

      peer.ontrack = (event) => {
        if (!remoteVideoRef.current) return;
        remoteVideoRef.current.srcObject =
          event.streams[0] || new MediaStream([event.track]);
        remoteVideoRef.current.play().catch((error) => {
          console.warn("Remote video autoplay was blocked:", error);
          setStatus("Call connected. Press play to hear and see the other person.");
        });
      };

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("call-ice-candidate", event.candidate);
        }
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") setStatus("Call connected");
        if (["failed", "disconnected"].includes(peer.connectionState)) {
          setStatus("Call connection interrupted. Trying to reconnect...");
        }
      };

      return peer;
    };

    const addPendingCandidates = async (peer) => {
      const candidates = pendingCandidatesRef.current;
      pendingCandidatesRef.current = [];
      for (const candidate of candidates) {
        await peer.addIceCandidate(candidate);
      }
    };

    const maybeCreateOffer = async () => {
      if (
        !active ||
        !socket.connected ||
        !localStreamRef.current ||
        !peerPresentRef.current ||
        !shouldOfferRef.current ||
        offerStartedRef.current
      ) {
        return;
      }

      offerStartedRef.current = true;

      try {
        const peer = createPeerConnection();
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit("call-offer", peer.localDescription);
        setStatus("Calling...");
      } catch (error) {
        console.error("Could not start private call:", error);
        offerStartedRef.current = false;
        closePeer();
        setStatus("Could not start the call. Check your camera and microphone permissions.");
      }
    };

    const handleOffer = async (offer) => {
      if (!localStreamRef.current) {
        pendingOfferRef.current = offer;
        return;
      }

      try {
        closePeer();
        const peer = createPeerConnection();
        await peer.setRemoteDescription(new RTCSessionDescription(offer));
        await addPendingCandidates(peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit("call-answer", peer.localDescription);
        setStatus("Connecting your call...");
      } catch (error) {
        console.error("Could not answer private call:", error);
        setStatus("Could not connect the call. Please leave and try again.");
      }
    };

    const onConnect = () => {
      socket.emit("call-join", { roomId });
    };

    const onConnectError = (error) => {
      console.error("Socket connection error:", error);
      setStatus("Could not connect to the backend. Check that it is running.");
    };

    const onDisconnect = () => {
      closePeer();
      peerPresentRef.current = false;
      setStatus("Disconnected from backend. Reconnecting...");
    };

    const onCallJoined = ({ peerPresent, shouldOffer }) => {
      if (mediaUnavailableRef.current) return;
      peerPresentRef.current = peerPresent;
      shouldOfferRef.current = shouldOffer;
      setStatus(peerPresent ? "Joining the call..." : "Waiting for someone to join...");
      if (peerPresent && shouldOffer) void maybeCreateOffer();
    };

    const onPeerJoined = () => {
      if (mediaUnavailableRef.current) return;
      peerPresentRef.current = true;
      setStatus("Someone joined. Connecting...");
      void maybeCreateOffer();
    };

    const onOffer = (offer) => {
      void handleOffer(offer);
    };

    const onAnswer = async (answer) => {
      try {
        if (!peerRef.current) return;
        await peerRef.current.setRemoteDescription(
          new RTCSessionDescription(answer)
        );
        await addPendingCandidates(peerRef.current);
      } catch (error) {
        console.error("Could not complete private call setup:", error);
        setStatus("Could not complete the call connection.");
      }
    };

    const onIceCandidate = async (candidate) => {
      try {
        if (!candidate) return;
        const iceCandidate = new RTCIceCandidate(candidate);
        if (peerRef.current?.remoteDescription) {
          await peerRef.current.addIceCandidate(iceCandidate);
        } else {
          pendingCandidatesRef.current.push(iceCandidate);
        }
      } catch (error) {
        console.error("Could not add call network candidate:", error);
      }
    };

    const onPeerLeft = () => {
      closePeer();
      peerPresentRef.current = false;
      shouldOfferRef.current = true;
      offerStartedRef.current = false;
      setStatus("The other person left. Waiting for someone to join...");
    };

    const onRoomFull = () => {
      setRoomFull(true);
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      setStatus("This private call already has two people.");
    };

    const onCallError = (message) => {
      setStatus(message || "Could not join this private call.");
    };

    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);
    socket.on("call-joined", onCallJoined);
    socket.on("call-peer-joined", onPeerJoined);
    socket.on("call-peer-left", onPeerLeft);
    socket.on("call-room-full", onRoomFull);
    socket.on("call-error", onCallError);
    socket.on("call-offer", onOffer);
    socket.on("call-answer", onAnswer);
    socket.on("call-ice-candidate", onIceCandidate);

    if (socket.connected) onConnect();
    else socket.connect();

    const getUserMedia = navigator.mediaDevices?.getUserMedia;
    if (getUserMedia) {
      getCallMedia(navigator.mediaDevices)
        .then((stream) => {
          if (!active) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          localStreamRef.current = stream;
          const hasAudio = stream.getAudioTracks().length > 0;
          const hasVideo = stream.getVideoTracks().length > 0;
          setHasMicrophone(hasAudio);
          setHasCamera(hasVideo);
          if (!hasAudio) setMicEnabled(false);
          if (!hasVideo) setCameraEnabled(false);
          stream.getAudioTracks().forEach((track) => {
            track.enabled = micEnabledRef.current;
          });
          stream.getVideoTracks().forEach((track) => {
            track.enabled = cameraEnabledRef.current;
          });
          if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          if (pendingOfferRef.current) {
            const offer = pendingOfferRef.current;
            pendingOfferRef.current = null;
            void handleOffer(offer);
          } else {
            void maybeCreateOffer();
          }
        })
        .catch((error) => {
          console.error("Could not access camera or microphone:", error);
          mediaUnavailableRef.current = true;
          socket.emit("call-leave");
          closePeer();

          if (error.name === "NoMediaDevicesError") {
            setStatus("No camera or microphone was found. Connect a device, then reload the call.");
          } else if (error.name === "NotAllowedError" || error.name === "SecurityError") {
            setStatus("Camera and microphone access was blocked. Allow access in browser site settings, then reload.");
          } else if (error.name === "NotReadableError") {
            setStatus("The camera or microphone could not start. Close other apps using them, then reload.");
          } else {
            setStatus("Could not start the camera or microphone. Check that a device is connected and not in use, then reload.");
          }
        });
    }

    return () => {
      active = false;
      socket.off("connect", onConnect);
      socket.off("connect_error", onConnectError);
      socket.off("disconnect", onDisconnect);
      socket.off("call-joined", onCallJoined);
      socket.off("call-peer-joined", onPeerJoined);
      socket.off("call-peer-left", onPeerLeft);
      socket.off("call-room-full", onRoomFull);
      socket.off("call-error", onCallError);
      socket.off("call-offer", onOffer);
      socket.off("call-answer", onAnswer);
      socket.off("call-ice-candidate", onIceCandidate);
      socket.emit("call-leave");
      closePeer();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    };
  }, [roomId]);

  const toggleMicrophone = () => {
    if (!hasMicrophone) return;
    const enabled = !micEnabled;
    micEnabledRef.current = enabled;
    (localStreamRef.current?.getAudioTracks() || []).forEach((track) => {
      track.enabled = enabled;
    });
    setMicEnabled(enabled);
  };

  const toggleCamera = () => {
    if (!hasCamera) return;
    const enabled = !cameraEnabled;
    cameraEnabledRef.current = enabled;
    (localStreamRef.current?.getVideoTracks() || []).forEach((track) => {
      track.enabled = enabled;
    });
    setCameraEnabled(enabled);
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      console.error("Could not copy the private call link:", error);
      setStatus("Could not copy the link. Copy it from the address bar instead.");
    }
  };

  const endCall = () => {
    socket.emit("call-leave");
    navigate("/");
  };

  return (
    <main className="call-page">
      <header className="call-header">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>streamline</span>
        </Link>
        <Link className="call-home-link" to="/">Back to home</Link>
      </header>

      <section className="call-main">
        <div className="call-heading">
          <p className="call-eyebrow">PRIVATE VIDEO ROOM</p>
          <h1>Your call, your people.</h1>
          <p className="call-status" role="status">{status}</p>
        </div>

        <div className="call-videos">
          <div className="call-video-tile local-tile">
            <video ref={localVideoRef} autoPlay playsInline muted />
            <span className="video-name">You</span>
            {(!cameraEnabled || !hasCamera) && (
              <span className="camera-off">{hasCamera ? "Camera off" : "Camera unavailable"}</span>
            )}
          </div>
          <div className="call-video-tile remote-tile">
            <video ref={remoteVideoRef} autoPlay playsInline controls aria-label="Guest video" />
            <span className="video-name">Guest</span>
          </div>
        </div>

        <div className="call-toolbar" aria-label="Call controls">
          <button
            className={`call-control${micEnabled ? "" : " is-off"}`}
            type="button"
            onClick={toggleMicrophone}
            aria-pressed={micEnabled}
            disabled={!hasMicrophone}
          >
            {!hasMicrophone ? "No microphone" : micEnabled ? "Mute microphone" : "Unmute microphone"}
          </button>
          <button
            className={`call-control${cameraEnabled ? "" : " is-off"}`}
            type="button"
            onClick={toggleCamera}
            aria-pressed={cameraEnabled}
            disabled={!hasCamera}
          >
            {!hasCamera ? "No camera" : cameraEnabled ? "Turn camera off" : "Turn camera on"}
          </button>
          <button className="call-control end-call" type="button" onClick={endCall}>
            Leave call
          </button>
        </div>

        <div className="invite-panel">
          <div>
            <strong>Invite someone to this call</strong>
            <p>Only people with this link can join. Calls are limited to two people.</p>
          </div>
          <button className="copy-invite" type="button" onClick={copyInvite} disabled={roomFull}>
            {copied ? "Copied!" : "Copy invite link"}
          </button>
        </div>
      </section>
    </main>
  );
}

export default PrivateCall;
