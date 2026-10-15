const fallbackIceServers = [{ urls: "stun:stun.l.google.com:19302" }];

export async function fetchIceServers() {
  const response = await fetch("/api/ice-servers", { cache: "no-store" });
  const responseBody = await response.text();
  let data;
  try {
    data = JSON.parse(responseBody);
  } catch {
    throw new Error(
      "The call server does not provide TURN settings yet. Restart the backend, then try again."
    );
  }
  if (!response.ok) {
    throw new Error(data.error || "Could not load call network configuration.");
  }
  if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
    throw new Error("The call server returned an invalid network configuration.");
  }
  return {
    iceServers: data.iceServers,
    turnConfigured: data.turnConfigured === true
  };
}

export { fallbackIceServers };
