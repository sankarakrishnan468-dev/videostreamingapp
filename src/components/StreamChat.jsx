import { useEffect } from "react";
import socket from "../services/socket";
import CommentThread from "./CommentThread.jsx";
import "./StreamChat.css";

function StreamChat({ role, roomId }) {
  useEffect(() => {
    if (!roomId) return undefined;
    const joinLiveRoom = () => socket.emit("join-live-room", { roomId });
    socket.on("connect", joinLiveRoom);
    if (socket.connected) joinLiveRoom();
    else socket.connect();
    return () => {
      socket.off("connect", joinLiveRoom);
      if (socket.connected) socket.emit("leave-live-room");
    };
  }, [roomId]);

  return (
    <aside className="stream-chat" aria-label={`${role} live comments`}>
      {roomId
        ? <CommentThread targetType="live" targetId={roomId} title="Live comments" />
        : <p className="comment-thread-state">Waiting for a live stream...</p>}
    </aside>
  );
}

export default StreamChat;
