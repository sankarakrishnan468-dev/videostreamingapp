import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import socket, { socketConfigured } from "../services/socket";
import { fallbackIceServers, fetchIceServers } from "../services/iceServers";
import "./VideoRoom.css";

const MAX_PARTICIPANTS = 4;

async function getAvailableMedia(mediaDevices) {
  try {
    return {
      stream: await mediaDevices.getUserMedia({ audio: true, video: true }),
      error: null,
      failures: []
    };
  } catch (combinedError) {
    const tracks = [];
    const failures = [];

    for (const [device, constraints] of [
      ["Microphone", { audio: true, video: false }],
      ["Camera", { audio: false, video: true }]
    ]) {
      try {
        const stream = await mediaDevices.getUserMedia(constraints);
        tracks.push(...stream.getTracks());
      } catch (error) {
        failures.push({ device, name: error.name, message: error.message });
      }
    }

    if (tracks.length) return { stream: new MediaStream(tracks), error: null, failures };

    const mediaError = new Error("No camera or microphone could be opened.");
    mediaError.name = failures.some((error) =>
      ["NotAllowedError", "SecurityError"].includes(error.name)
    )
      ? "NotAllowedError"
      : failures.some((error) => error.name === "NotReadableError")
        ? "NotReadableError"
        : failures.length > 0 && failures.every((error) => error.name === "NotFoundError")
          ? "NotFoundError"
          : combinedError.name;

    return { stream: new MediaStream(), error: mediaError, failures };
  }
}

function VideoRoom() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const localVideoRef = useRef(null);
  const inviteLinkRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const remoteStreamsRef = useRef(new Map());
  const peerConnectionsRef = useRef(new Map());
  const iceServersRef = useRef(fallbackIceServers);
  const videoSendersRef = useRef(new Map());
  const pendingCandidatesRef = useRef(new Map());
  const joinedRef = useRef(false);
  const hostKeyRef = useRef(null);
  const roomPasswordRef = useRef("");
  const hostMutedRef = useRef(false);
  const micEnabledRef = useRef(true);
  const [remoteUsers, setRemoteUsers] = useState({});
  const [participants, setParticipants] = useState([]);
  const [hostId, setHostId] = useState("");
  const [waitingParticipants, setWaitingParticipants] = useState([]);
  const [raisedHands, setRaisedHands] = useState(new Set());
  const [mutedParticipants, setMutedParticipants] = useState(new Set());
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("Preparing your call...");
  const [networkWarning, setNetworkWarning] = useState("");
  const [mediaWarning, setMediaWarning] = useState("");
  const [retryingMedia, setRetryingMedia] = useState(false);
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const [hasCamera, setHasCamera] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [hostMuted, setHostMuted] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [roomPassword, setRoomPassword] = useState("");
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState("");
  const [copied, setCopied] = useState(false);
  const [inviteMessage, setInviteMessage] = useState("");
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const publicAppUrl = import.meta.env.VITE_PUBLIC_APP_URL?.trim();
  const inviteLink = isLocalHost && publicAppUrl
    ? new URL(`${window.location.pathname}${window.location.search}${window.location.hash}`, publicAppUrl).href
    : window.location.href;
  const inviteNeedsPublicUrl = isLocalHost && !publicAppUrl;

  useEffect(() => {
    try {
      hostKeyRef.current = window.sessionStorage.getItem(`streamline.callHost.${roomId}`) || "";
    } catch (error) {
      console.error("Could not load this meeting's host credentials:", error);
    }

    let active = true;
    let mediaStarted = false;

    const peerConnections = peerConnectionsRef.current;
    const closePeer = (userId) => {
      peerConnections.get(userId)?.close();
      peerConnections.delete(userId);
      remoteStreamsRef.current.delete(userId);
      videoSendersRef.current.delete(userId);
      pendingCandidatesRef.current.delete(userId);
      setRemoteUsers((users) => {
        if (!users[userId]) return users;
        const nextUsers = { ...users };
        delete nextUsers[userId];
        return nextUsers;
      });
    };

    const addPendingCandidates = async (userId, peer) => {
      const candidates = pendingCandidatesRef.current.get(userId) || [];
      pendingCandidatesRef.current.delete(userId);
      for (const candidate of candidates) {
        await peer.addIceCandidate(candidate);
      }
    };

    const createPeerConnection = (userId) => {
      const existingPeer = peerConnections.get(userId);
      if (existingPeer) return existingPeer;

      const peer = new RTCPeerConnection({
        iceServers: iceServersRef.current
      });
      peerConnections.set(userId, peer);

      const stream = localStreamRef.current;
      const tracks = stream?.getTracks() || [];
      const audioTracks = tracks.filter((track) => track.kind === "audio");
      const screenTrack = screenStreamRef.current?.getVideoTracks()[0];
      const videoTracks = screenTrack
        ? [screenTrack]
        : tracks.filter((track) => track.kind === "video");

      if (audioTracks.length) {
        audioTracks.forEach((track) => peer.addTrack(track, stream));
      } else {
        peer.addTransceiver("audio", { direction: "recvonly" });
      }

      if (videoTracks.length) {
        videoTracks.forEach((track) => {
          const videoSender = peer.addTrack(track, screenTrack ? screenStreamRef.current : stream);
          videoSendersRef.current.set(userId, videoSender);
        });
      } else {
        const videoSender = peer.addTransceiver("video", { direction: "sendrecv" }).sender;
        videoSendersRef.current.set(userId, videoSender);
      }

      peer.ontrack = (event) => {
        let remoteStream = event.streams[0] || remoteStreamsRef.current.get(userId);
        if (!remoteStream) remoteStream = new MediaStream();
        if (!remoteStream.getTracks().some((track) => track.id === event.track.id)) {
          remoteStream.addTrack(event.track);
        }
        remoteStreamsRef.current.set(userId, remoteStream);
        setRemoteUsers((users) => ({
          ...users,
          [userId]: remoteStream
        }));
      };

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("group-ice-candidate", {
            target: userId,
            candidate: event.candidate
          });
        }
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connecting") {
          setStatus(`Connecting to ${userId.slice(0, 5)}...`);
        }
        if (peer.connectionState === "connected") {
          setStatus("Connected to the private call.");
        }
        if (peer.connectionState === "disconnected") {
          setStatus("A participant connection was interrupted. Trying to reconnect...");
        }
        if (peer.connectionState === "failed") {
          setStatus("A participant connection failed. Check network access or configure TURN.");
        }
      };

      return peer;
    };

    const createOffer = async (userId) => {
      try {
        const peer = createPeerConnection(userId);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit("group-offer", {
          target: userId,
          description: peer.localDescription
        });
      } catch (error) {
        console.error(`Could not start call with participant ${userId}:`, error);
        setStatus("Could not establish a connection with a participant.");
      }
    };

    const handleOffer = async ({ sender, description }) => {
      try {
        const peer = createPeerConnection(sender);
        await peer.setRemoteDescription(new RTCSessionDescription(description));
        await addPendingCandidates(sender, peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit("group-answer", {
          target: sender,
          description: peer.localDescription
        });
      } catch (error) {
        console.error(`Could not answer participant ${sender}:`, error);
        setStatus("Could not connect to a participant. Please rejoin the room.");
      }
    };

    const joinRoom = () => {
      if (!active || !mediaStarted || joinedRef.current) return;
      joinedRef.current = true;
      socket.emit("group-join", {
        roomId,
        password: roomPasswordRef.current,
        hostKey: hostKeyRef.current
      });
      setStatus("Joining private room...");
    };

    const onConnect = () => {
      joinedRef.current = false;
      joinRoom();
    };

    const onConnectError = (error) => {
      console.error("Signaling connection failed:", error);
      setStatus("Could not reach the call server. Check that the backend is running.");
    };

    const onDisconnect = () => {
      joinedRef.current = false;
      setJoined(false);
      setParticipants([]);
      for (const userId of peerConnections.keys()) closePeer(userId);
      setStatus("Call server disconnected. Reconnecting...");
    };

    const onRoomJoined = ({ participants: existingParticipants, capacity, hostId: roomHostId }) => {
      const others = existingParticipants || [];
      joinedRef.current = true;
      setParticipants([socket.id, ...others]);
      setHostId(roomHostId || socket.id);
      setJoined(true);
      setWaitingApproval(false);
      setRequiresPassword(false);
      setRoomPassword("");
      roomPasswordRef.current = "";
      setStatus(`In private room · ${others.length + 1} of ${capacity} participants`);
      try {
        const history = JSON.parse(localStorage.getItem("streamline.meetingHistory") || "[]");
        if (!Array.isArray(history)) throw new Error("Meeting history has an invalid format.");
        const entry = {
          roomId,
          joinedAt: new Date().toISOString(),
          inviteUrl: window.location.href
        };
        localStorage.setItem(
          "streamline.meetingHistory",
          JSON.stringify([entry, ...history.filter((item) => item.roomId !== roomId)].slice(0, 20))
        );
      } catch (error) {
        console.error("Could not save meeting history:", error);
      }
      others.forEach((userId) => void createOffer(userId));
    };

    const onParticipantJoined = ({ userId, count, capacity }) => {
      setParticipants((users) => users.includes(userId) ? users : [...users, userId]);
      setStatus(`A participant joined · ${count} of ${capacity} participants`);
    };

    const onParticipantLeft = ({ userId, count, capacity }) => {
      closePeer(userId);
      setParticipants((users) => users.filter((id) => id !== userId));
      setRaisedHands((users) => {
        const next = new Set(users);
        next.delete(userId);
        return next;
      });
      setMutedParticipants((users) => {
        const next = new Set(users);
        next.delete(userId);
        return next;
      });
      setStatus(`A participant left · ${count} of ${capacity} participants`);
    };

    const onHostChanged = ({ hostId: nextHostId }) => {
      setHostId(nextHostId);
      setStatus(nextHostId === socket.id ? "You are now the meeting host." : "The meeting host changed.");
    };

    const onPasswordRequired = () => {
      joinedRef.current = false;
      setRequiresPassword(true);
      setStatus("Enter the meeting password to continue.");
    };

    const onApprovalWait = () => {
      joinedRef.current = true;
      setWaitingApproval(true);
      setStatus("Waiting for the host to admit you...");
    };

    const onWaitingParticipant = ({ userId }) => {
      setWaitingParticipants((users) => users.includes(userId) ? users : [...users, userId]);
    };

    const onWaitingParticipantLeft = ({ userId }) => {
      setWaitingParticipants((users) => users.filter((id) => id !== userId));
    };

    const onAccessDenied = (message) => {
      joinedRef.current = false;
      setWaitingApproval(false);
      setStatus(message || "The host did not admit you to this call.");
    };

    const onRemoved = (message) => {
      joinedRef.current = false;
      setJoined(false);
      setStatus(message || "You were removed from this call.");
      navigate("/");
    };

    const onMeetingEnded = () => {
      joinedRef.current = false;
      setJoined(false);
      setStatus("The host ended this meeting.");
      navigate("/");
    };

    const onHostMute = ({ muted }) => {
      hostMutedRef.current = muted;
      setHostMuted(muted);
      if (muted) {
        micEnabledRef.current = localStreamRef.current?.getAudioTracks()
          .some((track) => track.enabled) || false;
        localStreamRef.current?.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        setMicEnabled(false);
      } else {
        localStreamRef.current?.getAudioTracks().forEach((track) => {
          track.enabled = micEnabledRef.current;
        });
        setMicEnabled(micEnabledRef.current);
      }
    };

    const onParticipantMuted = ({ userId, muted }) => {
      setMutedParticipants((users) => {
        const next = new Set(users);
        if (muted) next.add(userId);
        else next.delete(userId);
        return next;
      });
    };

    const onHandRaised = ({ userId, raised }) => {
      setRaisedHands((users) => {
        const next = new Set(users);
        if (raised) next.add(userId);
        else next.delete(userId);
        return next;
      });
    };

    const onChatMessage = (message) => {
      setChatMessages((messages) => [...messages, message].slice(-100));
    };

    const onChatError = (message) => {
      setChatError(message || "Could not send the message.");
    };

    const onRoomFull = () => {
      joinedRef.current = false;
      setStatus(`This room is full. Private rooms support up to ${MAX_PARTICIPANTS} people.`);
    };

    const onRoomError = (message) => {
      joinedRef.current = false;
      setWaitingApproval(false);
      if (typeof message === "string" && message.toLowerCase().includes("password")) {
        setRequiresPassword(true);
      }
      setStatus(message || "Could not join this private room.");
    };

    const onAnswer = async ({ sender, description }) => {
      const peer = peerConnections.get(sender);
      if (!peer) return;

      try {
        await peer.setRemoteDescription(new RTCSessionDescription(description));
        await addPendingCandidates(sender, peer);
      } catch (error) {
        console.error(`Could not complete connection with ${sender}:`, error);
      }
    };

    const onIceCandidate = async ({ sender, candidate }) => {
      try {
        const iceCandidate = new RTCIceCandidate(candidate);
        const peer = peerConnections.get(sender);
        if (peer?.remoteDescription) {
          await peer.addIceCandidate(iceCandidate);
        } else {
          const candidates = pendingCandidatesRef.current.get(sender) || [];
          candidates.push(iceCandidate);
          pendingCandidatesRef.current.set(sender, candidates);
        }
      } catch (error) {
        console.error(`Could not add network candidate from ${sender}:`, error);
      }
    };

    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);
    socket.on("group-room-joined", onRoomJoined);
    socket.on("group-participant-joined", onParticipantJoined);
    socket.on("group-participant-left", onParticipantLeft);
    socket.on("group-room-full", onRoomFull);
    socket.on("group-room-error", onRoomError);
    socket.on("group-password-required", onPasswordRequired);
    socket.on("group-approval-wait", onApprovalWait);
    socket.on("group-waiting-participant", onWaitingParticipant);
    socket.on("group-waiting-participant-left", onWaitingParticipantLeft);
    socket.on("group-access-denied", onAccessDenied);
    socket.on("group-host-changed", onHostChanged);
    socket.on("group-removed", onRemoved);
    socket.on("group-meeting-ended", onMeetingEnded);
    socket.on("group-host-mute", onHostMute);
    socket.on("group-participant-muted", onParticipantMuted);
    socket.on("group-hand-raised", onHandRaised);
    socket.on("group-chat-message", onChatMessage);
    socket.on("group-chat-error", onChatError);
    socket.on("group-offer", handleOffer);
    socket.on("group-answer", onAnswer);
    socket.on("group-ice-candidate", onIceCandidate);

    const startMedia = async () => {
      if (!socketConfigured) {
        setStatus("Backend URL is not configured.");
        return;
      }

      if (!roomId || !/^[a-f\d]{32}$/i.test(roomId)) {
        setStatus("This call link is invalid. Create a new private room.");
        return;
      }

      try {
        const networkConfiguration = await fetchIceServers();
        iceServersRef.current = networkConfiguration.iceServers;
        if (!networkConfiguration.turnConfigured) {
          setNetworkWarning("TURN is not configured; this call may not connect across restrictive networks.");
        }
      } catch (error) {
        console.warn("Could not load TURN configuration; using STUN:", error);
        iceServersRef.current = fallbackIceServers;
        setNetworkWarning(`${error.message} Using direct connection for this call.`);
      }
      const mediaDevices = navigator.mediaDevices;
      const mediaResult = mediaDevices?.getUserMedia
        ? await getAvailableMedia(mediaDevices)
        : {
          stream: new MediaStream(),
          error: Object.assign(
            new Error("Camera and microphone require HTTPS or localhost."),
            { name: "InsecureContextError" }
          )
        };
      const { stream, error: mediaError, failures } = mediaResult;

      if (!active) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      localStreamRef.current = stream;
      setHasMicrophone(stream.getAudioTracks().length > 0);
      setHasCamera(stream.getVideoTracks().length > 0);
      setMicEnabled(stream.getAudioTracks().length > 0);
      micEnabledRef.current = stream.getAudioTracks().length > 0;
      setCameraEnabled(stream.getVideoTracks().length > 0);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      if (mediaError) {
        console.error("Camera/microphone unavailable:", {
          name: mediaError.name,
          message: mediaError.message,
          deviceErrors: failures
        });
        if (mediaError.name === "NotFoundError") {
          let devices = [];
          try {
            devices = await mediaDevices?.enumerateDevices?.() || [];
          } catch (error) {
            console.warn("Could not list available camera and microphone devices:", error);
          }
          const availableInputs = devices?.filter((device) =>
            ["audioinput", "videoinput"].includes(device.kind)
          ) || [];
          setStatus(
            availableInputs.length
              ? "Camera/microphone access was denied or the selected device is unavailable. Check browser site settings and select an available device."
              : "This browser cannot detect a camera or microphone. Check the device connection and Windows privacy settings, then reload."
          );
        } else if (mediaError.name === "NotAllowedError" || mediaError.name === "SecurityError") {
          setStatus("Camera/microphone permission was denied. You can still join without sending media.");
        } else if (mediaError.name === "NotReadableError") {
          setStatus("Camera/microphone is busy or unavailable. You can still join without sending media.");
        } else if (mediaError.name === "InsecureContextError") {
          setStatus("Camera/microphone require HTTPS or localhost. Joining without sending media.");
        } else {
          setStatus("Could not start your camera or microphone. Joining without sending media.");
        }
        setMediaWarning(
          failures.map(({ device, name, message }) =>
            `${device}: ${name}${message ? ` (${message})` : ""}`
          ).join(" · ")
        );
      } else if (failures.length) {
        const missingDevices = failures.map(({ device }) => device.toLowerCase()).join(" and ");
        setMediaWarning(
          `${missingDevices} unavailable. Check browser site permissions and Windows Settings > Privacy & security > Microphone/Camera.`
        );
      }

      mediaStarted = true;
      if (socket.connected) joinRoom();
      else socket.connect();
    };

    void startMedia().catch((error) => {
      console.error("Could not prepare private room media:", error);
      setStatus("Could not prepare this call. Reload the room and try again.");
    });

    return () => {
      active = false;
      joinedRef.current = false;
      socket.off("connect", onConnect);
      socket.off("connect_error", onConnectError);
      socket.off("disconnect", onDisconnect);
      socket.off("group-room-joined", onRoomJoined);
      socket.off("group-participant-joined", onParticipantJoined);
      socket.off("group-participant-left", onParticipantLeft);
      socket.off("group-room-full", onRoomFull);
      socket.off("group-room-error", onRoomError);
      socket.off("group-password-required", onPasswordRequired);
      socket.off("group-approval-wait", onApprovalWait);
      socket.off("group-waiting-participant", onWaitingParticipant);
      socket.off("group-waiting-participant-left", onWaitingParticipantLeft);
      socket.off("group-access-denied", onAccessDenied);
      socket.off("group-host-changed", onHostChanged);
      socket.off("group-removed", onRemoved);
      socket.off("group-meeting-ended", onMeetingEnded);
      socket.off("group-host-mute", onHostMute);
      socket.off("group-participant-muted", onParticipantMuted);
      socket.off("group-hand-raised", onHandRaised);
      socket.off("group-chat-message", onChatMessage);
      socket.off("group-chat-error", onChatError);
      socket.off("group-offer", handleOffer);
      socket.off("group-answer", onAnswer);
      socket.off("group-ice-candidate", onIceCandidate);
      socket.emit("group-leave");
      for (const userId of peerConnections.keys()) closePeer(userId);
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
    };
  }, [navigate, roomId]);

  const toggleMicrophone = () => {
    if (hostMutedRef.current) return;
    const enabled = !micEnabled;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
    micEnabledRef.current = enabled;
    setMicEnabled(enabled);
  };

  const toggleCamera = () => {
    const enabled = !cameraEnabled;
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
    setCameraEnabled(enabled);
  };

  const retryMediaAccess = async () => {
    setRetryingMedia(true);
    try {
      const { stream, error, failures } = await getAvailableMedia(navigator.mediaDevices);
      stream.getTracks().forEach((track) => track.stop());
      if (error) {
        setMediaWarning(
          failures.map(({ device, name, message }) =>
            `${device}: ${name}${message ? ` (${message})` : ""}`
          ).join(" · ") || error.message
        );
        setStatus("Camera/microphone access is still unavailable. Check browser and Windows permissions.");
        return;
      }

      setStatus("Device access is available. Reloading the call to reconnect media...");
      window.location.reload();
    } catch (error) {
      console.error("Could not retry camera/microphone access:", error);
      setMediaWarning(`${error.name || "MediaError"}${error.message ? `: ${error.message}` : ""}`);
      setStatus("Camera/microphone access is still unavailable. Check browser and Windows permissions.");
    } finally {
      setRetryingMedia(false);
    }
  };

  const submitRoomPassword = (event) => {
    event.preventDefault();
    const password = roomPassword.trim();
    if (!password) return;
    roomPasswordRef.current = password;
    setRequiresPassword(false);
    setStatus("Checking meeting password...");
    socket.emit("group-join", { roomId, password, hostKey: hostKeyRef.current });
  };

  const toggleScreenShare = async () => {
    if (screenStreamRef.current) {
      await stopScreenShare();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });
      const [track] = stream.getVideoTracks();
      if (!track) throw new Error("No screen video track was returned.");

      screenStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      await Promise.all(
        [...videoSendersRef.current.values()].map((sender) => sender.replaceTrack(track))
      );
      track.addEventListener("ended", () => {
        void stopScreenShare();
      }, { once: true });
      setScreenSharing(true);
    } catch (error) {
      console.error("Could not start screen sharing:", error);
      setStatus(
        error.name === "NotAllowedError"
          ? "Screen sharing was cancelled or blocked."
          : "Could not start screen sharing. Check browser permissions and try again."
      );
    }
  };

  const stopScreenShare = async () => {
    const screenStream = screenStreamRef.current;
    if (!screenStream) return;
    screenStreamRef.current = null;
    setScreenSharing(false);
    screenStream.getTracks().forEach((track) => track.stop());
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;

    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;
    try {
      await Promise.all(
        [...videoSendersRef.current.values()].map((sender) => sender.replaceTrack(cameraTrack))
      );
    } catch (error) {
      console.error("Could not restore camera video after screen sharing:", error);
      setStatus("Screen sharing stopped, but the camera track could not be restored.");
    }
  };

  const setParticipantAdmission = (userId, approved) => {
    socket.emit("group-admit-participant", { target: userId, approved });
    setWaitingParticipants((users) => users.filter((id) => id !== userId));
  };

  const toggleParticipantMute = (userId) => {
    socket.emit("group-mute-participant", {
      target: userId,
      muted: !mutedParticipants.has(userId)
    });
  };

  const removeParticipant = (userId) => {
    socket.emit("group-remove-participant", { target: userId });
  };

  const toggleRaisedHand = () => {
    const raised = !handRaised;
    setHandRaised(raised);
    socket.emit("group-raise-hand", { raised });
  };

  const sendChatMessage = (event) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    setChatError("");
    socket.emit("group-chat-send", { text });
    setChatInput("");
  };

  const copyInvite = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is not available in this browser.");
      }
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setInviteMessage("Invite link copied. Send it to your guests.");
      window.setTimeout(() => setCopied(false), 1800);
      window.setTimeout(() => setInviteMessage(""), 4000);
    } catch (error) {
      console.warn("Clipboard access is unavailable; selecting the invite link instead.", error);
      inviteLinkRef.current?.focus();
      inviteLinkRef.current?.select();
      setInviteMessage("Link selected. Press Ctrl+C (or Cmd+C) to copy it.");
    }
  };

  const leaveRoom = () => {
    socket.emit("group-leave");
    navigate("/");
  };

  const endMeeting = () => {
    socket.emit("group-end-call");
    navigate("/");
  };

  return (
    <main className="group-call-page">
      <header className="group-call-header">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>streamline</span>
        </Link>
        <span className="group-call-capacity">
          {participants.length || 1} / {MAX_PARTICIPANTS} people
        </span>
      </header>

      <section className="group-call-main">
        <div className="group-call-heading">
          <p className="call-eyebrow">PRIVATE VIDEO ROOM</p>
          <h1>Bring your people together.</h1>
          <p className="group-call-status" role="status">{status}</p>
          {networkWarning && <p className="group-call-status group-call-network-warning" role="status">{networkWarning}</p>}
          {mediaWarning && <p className="group-call-status group-call-media-warning" role="status">{mediaWarning}</p>}
          {mediaWarning && (
            <button
              className="group-retry-media"
              type="button"
              onClick={() => void retryMediaAccess()}
              disabled={retryingMedia}
            >
              {retryingMedia ? "Checking devices..." : "Retry camera and microphone"}
            </button>
          )}
        </div>

        <div className="group-video-grid">
          <div className="group-video-card">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              hidden={!hasCamera}
            />
            {!hasCamera && (
              <div className="group-video-placeholder">
                Camera unavailable
              </div>
            )}
            <span className="group-video-label">You</span>
          </div>

          {Object.entries(remoteUsers).map(([userId, stream]) => (
            <RemoteVideo
              key={userId}
              userId={userId}
              stream={stream}
              audioTrackCount={stream.getAudioTracks().length}
              muted={mutedParticipants.has(userId)}
              raisedHand={raisedHands.has(userId)}
              host={userId === hostId}
            />
          ))}

          {joined && participants.length === 1 && (
            <div className="group-waiting-card">
              <span className="waiting-indicator" />
              <strong>Waiting for others</strong>
              <span>Share the invite link to add up to {MAX_PARTICIPANTS - 1} guests.</span>
            </div>
          )}
        </div>

        {requiresPassword && (
          <form className="group-password-form" onSubmit={submitRoomPassword}>
            <label htmlFor="group-room-password">This meeting is password protected</label>
            <div>
              <input
                id="group-room-password"
                type="password"
                autoComplete="current-password"
                value={roomPassword}
                onChange={(event) => setRoomPassword(event.target.value)}
                placeholder="Enter meeting password"
                required
              />
              <button type="submit">Continue</button>
            </div>
          </form>
        )}

        {waitingApproval && (
          <div className="group-waiting-notice" role="status">
            <span className="waiting-indicator" />
            Waiting for the host to admit you. Keep this page open.
          </div>
        )}

        <div className="group-call-controls" aria-label="Call controls">
          <button type="button" onClick={toggleMicrophone} disabled={!hasMicrophone}>
            {!hasMicrophone ? "No microphone" : hostMuted ? "Muted by host" : micEnabled ? "Mute microphone" : "Turn microphone on"}
          </button>
          <button type="button" onClick={toggleCamera} disabled={!hasCamera}>
            {!hasCamera ? "No camera" : cameraEnabled ? "Turn camera off" : "Turn camera on"}
          </button>
          <button
            type="button"
            onClick={() => void toggleScreenShare()}
            disabled={!navigator.mediaDevices?.getDisplayMedia || !joined}
          >
            {screenSharing ? "Stop sharing" : "Share screen"}
          </button>
          <button type="button" onClick={toggleRaisedHand} disabled={!joined}>
            {handRaised ? "Lower hand" : "Raise hand"}
          </button>
          <button className="leave-group-call" type="button" onClick={hostId === socket.id ? endMeeting : leaveRoom}>
            {hostId === socket.id ? "End meeting" : "Leave call"}
          </button>
        </div>

        <div className="group-call-tools">
          <section className="group-participant-panel" aria-label="Participants">
            <div className="group-panel-heading">
              <h2>People</h2>
              <span>{participants.length}/{MAX_PARTICIPANTS}</span>
            </div>
            <ul className="group-participant-list">
              {participants.map((userId) => {
                const isSelf = userId === socket.id;
                const isHost = userId === hostId;
                return (
                  <li key={userId}>
                    <span className="group-participant-name">
                      <span className="participant-presence" />
                      {isSelf ? "You" : `Guest ${userId.slice(0, 5)}`}
                      {(raisedHands.has(userId) || (isSelf && handRaised)) && <span className="participant-hand" aria-label="Hand raised">✋</span>}
                      {mutedParticipants.has(userId) && <span className="participant-muted">Muted</span>}
                      {isHost && <span className="participant-host">Host</span>}
                    </span>
                    {hostId === socket.id && !isSelf && (
                      <span className="participant-actions">
                        <button type="button" onClick={() => toggleParticipantMute(userId)}>
                          {mutedParticipants.has(userId) ? "Unmute" : "Mute"}
                        </button>
                        <button type="button" onClick={() => removeParticipant(userId)}>Remove</button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {hostId === socket.id && waitingParticipants.length > 0 && (
              <div className="group-waiting-list">
                <h3>Waiting to join</h3>
                {waitingParticipants.map((userId) => (
                  <div className="group-waiting-person" key={userId}>
                    <span>Guest {userId.slice(0, 5)}</span>
                    <span>
                      <button type="button" onClick={() => setParticipantAdmission(userId, true)}>Admit</button>
                      <button type="button" onClick={() => setParticipantAdmission(userId, false)}>Deny</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="group-chat-panel" aria-label="Meeting chat">
            <div className="group-panel-heading">
              <h2>In-call chat</h2>
              <span>{chatMessages.length}</span>
            </div>
            <div className="group-chat-messages" aria-live="polite">
              {chatMessages.length === 0
                ? <p className="group-chat-empty">Messages shared in this call appear here.</p>
                : chatMessages.map((message) => (
                  <article className="group-chat-message" key={message.id}>
                    <div><strong>{message.sender === socket.id ? "You" : `Guest ${message.sender.slice(0, 5)}`}</strong><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
                    <p>{message.text}</p>
                  </article>
                ))}
            </div>
            <form className="group-chat-form" onSubmit={sendChatMessage}>
              <input
                aria-label="Write a chat message"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                maxLength={500}
                placeholder="Send a message..."
                disabled={!joined}
              />
              <button type="submit" disabled={!joined || !chatInput.trim()}>Send</button>
            </form>
            {chatError && <p className="group-chat-error" role="alert">{chatError}</p>}
          </section>
        </div>

        <div className="group-invite-panel">
          <div>
            <strong>Invite up to {MAX_PARTICIPANTS - 1} guests</strong>
            <p>Send this same link to each guest. Anyone with it can join while a seat is available.</p>
            <input
              ref={inviteLinkRef}
              className="group-invite-link"
              type="text"
              aria-label="Private room invite link"
              value={inviteLink}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            {inviteNeedsPublicUrl && (
              <p className="group-invite-warning">
                Set VITE_PUBLIC_APP_URL to your public HTTPS tunnel address, then restart the frontend to create links that work on mobile.
              </p>
            )}
            {inviteMessage && <p className="group-invite-feedback" role="status">{inviteMessage}</p>}
          </div>
          <button type="button" onClick={copyInvite}>
            {copied ? "Copied!" : "Copy invite link"}
          </button>
        </div>
      </section>
    </main>
  );
}

function RemoteVideo({ userId, stream, audioTrackCount, muted, raisedHand, host }) {
  const videoRef = useRef(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.muted = muted;
    video.play().then(() => {
      setPlaybackBlocked(false);
    }).catch((error) => {
      if (error.name === "NotAllowedError") {
        setPlaybackBlocked(true);
      } else {
        console.warn(`Could not play media from participant ${userId}:`, error);
      }
    });
  }, [audioTrackCount, muted, stream, userId]);

  const enablePlayback = async () => {
    try {
      await videoRef.current?.play();
      setPlaybackBlocked(false);
    } catch (error) {
      console.error(`Could not enable media playback from participant ${userId}:`, error);
    }
  };

  return (
    <div className="group-video-card">
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      {playbackBlocked && (
        <button className="group-enable-audio" type="button" onClick={() => void enablePlayback()}>
          {audioTrackCount ? "Tap to enable call audio" : "Tap to start video"}
        </button>
      )}
      <span className="group-video-label">
        Guest {userId.slice(0, 5)}{host ? " · Host" : ""}{raisedHand ? " · ✋" : ""}{muted ? " · Muted" : ""}
      </span>
    </div>
  );
}

export default VideoRoom;
