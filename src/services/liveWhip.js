
import { fallbackIceServers, fetchIceServers } from "./iceServers.js";

function waitForIceGathering(peer, timeoutMs = 15000) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let timeout;

    const cleanup = () => {
      window.clearTimeout(timeout);
      peer.removeEventListener(
        "icegatheringstatechange",
        onStateChange
      );
    };

    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };

    timeout = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Timed out preparing the broadcast network connection."
        )
      );
    }, timeoutMs);

    peer.addEventListener(
      "icegatheringstatechange",
      onStateChange
    );
  });
}

export async function publishWhip(
  stream,
  whipUrl,
  publisherKey,
  onConnectionStateChange = () => {}
) {
  if (!stream) {
    throw new Error("A media stream is required.");
  }

  if (!whipUrl || !publisherKey) {
    throw new Error(
      "The broadcast URL or publisher key is missing."
    );
  }

  // WHIP still needs ICE connectivity after the HTTP offer/answer exchange.
  // Use the backend's STUN/TURN configuration so publishers behind NAT or
  // restrictive networks can reach MediaMTX. Keep the STUN fallback available
  // when the optional network-configuration endpoint cannot be reached.
  let iceServers = fallbackIceServers;
  try {
    ({ iceServers } = await fetchIceServers());
  } catch (iceError) {
    console.warn("Could not load broadcast ICE configuration; using STUN fallback:", iceError);
  }

  const peer = new RTCPeerConnection({ iceServers });
  let resourceUrl = "";
  let closed = false;

  const authorization = `Basic ${btoa(
    `streamline:${publisherKey}`
  )}`;
  let resolvedWhipUrl;

  try {
    // The backend may return a same-origin proxy path (for example /whip/...)
    // or an absolute MediaMTX URL. Resolve both forms before using the URL as
    // the base for MediaMTX's Location header.
    try {
      resolvedWhipUrl = new URL(whipUrl, window.location.origin).href;
    } catch (urlError) {
      throw new Error(
        "The broadcast server returned an invalid WHIP URL. Check LIVE_WHIP_BASE_URL and the Vite /whip proxy.",
        { cause: urlError }
      );
    }

    // Add the existing video and audio tracks.
    for (const track of stream.getTracks()) {
      peer.addTrack(track, stream);
    }

    // Ensure that an audio sender exists even when the
    // stream starts without a microphone track.
    let audioSender = peer
      .getSenders()
      .find((sender) => sender.track?.kind === "audio");

    if (!audioSender) {
      const audioTransceiver = peer.addTransceiver("audio", {
        direction: "sendonly"
      });

      audioSender = audioTransceiver.sender;
    }

    peer.addEventListener("connectionstatechange", () => {
      onConnectionStateChange(peer.connectionState);
    });

    const offer = await peer.createOffer();

    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);

    const response = await fetch(resolvedWhipUrl, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/sdp",
        Accept: "application/sdp"
      },
      body: peer.localDescription.sdp
    });

    if (!response.ok) {
      const detail = await response.text();

      throw new Error(
        detail ||
          `Media server rejected the broadcast (HTTP ${response.status}).`
      );
    }

    const location = response.headers.get("Location");

    if (location) {
      const whipEndpoint = new URL(resolvedWhipUrl);
      const resource = new URL(location, whipEndpoint);
      const endpointPath = whipEndpoint.pathname.match(
        /^(.*\/)([a-f\d]{32}\/whip)$/i
      );

      // MediaMTX returns a root-relative Location such as
      // /<roomId>/whip/<sessionId>. Behind Vite's /whip proxy that path must
      // retain the proxy prefix, or DELETE is sent to Vite instead of MediaMTX.
      if (endpointPath && resource.pathname.startsWith(`/${endpointPath[2]}/`)) {
        resource.pathname = `${endpointPath[1]}${resource.pathname.slice(1)}`;
        resourceUrl = new URL(
          `${resource.pathname}${resource.search}${resource.hash}`,
          whipEndpoint.origin
        ).href;
      } else {
        resourceUrl = resource.href;
      }
    }

    const answer = await response.text();

    if (!answer.trim()) {
      throw new Error(
        "The media server returned an empty WHIP answer."
      );
    }

    await peer.setRemoteDescription({
      type: "answer",
      sdp: answer
    });

    return {
      peer,
      audioSender,

      close: async () => {
        if (closed) return;
        closed = true;

        try {
          if (resourceUrl) {
            const deleteResponse = await fetch(resourceUrl, {
              method: "DELETE",
              headers: {
                Authorization: authorization
              }
            });

            if (
              !deleteResponse.ok &&
              deleteResponse.status !== 404 &&
              deleteResponse.status !== 410
            ) {
              console.warn(
                "Could not delete the WHIP session:",
                deleteResponse.status
              );
            }
          }
        } catch (error) {
          console.warn(
            "Error closing the WHIP session:",
            error
          );
        } finally {
          if (peer.signalingState !== "closed") {
            peer.close();
          }
        }
      }
    };
  } catch (error) {
    if (peer.signalingState !== "closed") {
      peer.close();
    }

    throw error;
  }
}
