import { io } from "socket.io-client";

const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL?.trim();
const socketUrl = configuredSocketUrl || window.location.origin;
export const socketConfigured = true;

console.log("Socket URL:", socketUrl);

const socket = io(socketUrl, {
  autoConnect: true,
  transports: ["polling", "websocket"],
  reconnection: true,
  // The backend waits for MongoDB before it starts listening. Keep trying
  // through that startup window instead of permanently losing live updates.
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

socket.on("connect", () => {
  console.log("✅ Socket connected:", socket.id);
});

socket.on("connect_error", (error) => {
  console.error("❌ Socket connection error:", error.message);
});

socket.on("disconnect", (reason) => {
  console.log("⚠️ Socket disconnected:", reason);
});

export default socket;
