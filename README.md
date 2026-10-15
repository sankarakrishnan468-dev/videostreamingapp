# Streamline

Streamline is a React/Vite frontend with a Node/Express backend, MongoDB, shared
Socket.IO chat, and private WebRTC video rooms. Public live broadcasts use
MediaMTX WHIP ingest and HLS playback; video bytes never pass through Express
or Socket.IO. Put an HLS-capable CDN in front of MediaMTX for large audiences.

## Run locally

1. In a terminal, start the backend:

   ```powershell
   npm --prefix backend install
   npm --prefix backend start
   ```

   It listens on `http://localhost:5000` (configured by `PORT` in
   `backend/.env`).

2. Download the current Windows AMD64 release from
   [MediaMTX releases](https://github.com/bluenviron/mediamtx/releases/latest),
   extract `mediamtx.exe` into the project root, and start a second terminal
   there:

   ```powershell
   .\mediamtx.exe .\mediamtx.yml
   ```

   The included configuration calls the backend for publisher authorization.
   MediaMTX listens on HLS HTTP `8888`, WHIP HTTP `8889`, and WebRTC ICE UDP
   `8189`. Keep this process running while broadcasting.

3. In a third terminal at the project root, start the frontend:

   ```powershell
   npm install
   npm run dev
   ```

   Vite proxies API and Socket.IO traffic to the backend. It checks the service
   ports and starts the backend or MediaMTX only when they are not already
   running. Local stream URLs default to `http://localhost:8888` and
   `http://localhost:8889`.

4. Open `http://localhost:5173`, sign in, and select **Live streams** or
   **Streamer**.

## Create an account and sign in

1. In MongoDB Atlas, create a project and cluster.
2. Under **Database Access**, create a database user. Under **Network Access**,
   allow the IP address where the backend will run. Avoid opening access to all
   IP addresses unless you understand the risk.
3. Select **Connect → Drivers**, copy the Node.js connection string, and
   replace its username/password placeholders. Add `/streamline` before the
   query string so the database name is `streamline`. If the password contains
   reserved URL characters, URL-encode it.
4. In `backend/`, copy `.env.example` to `.env`, then set `MONGODB_URI` to that
   Atlas connection string and `JWT_SECRET` to a private random value of at
   least 32 characters. Generate the JWT secret with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. Restart the backend, open **Sign in**, and choose **Sign up** to create an
   account. Sign in with the username and password afterward. An account is
   required to start a stream; viewers can watch without signing in.

Passwords are stored as bcrypt hashes, not plain text. The backend sets a
seven-day, HttpOnly, SameSite=Lax session cookie; the JWT signing secret must
remain private and stable across backend restarts. MongoDB stores accounts,
video metadata, follows, watch history, favorites, watch-later lists, private
meeting details, and authenticated meeting participation. Uploaded video bytes
remain on disk under `backend/uploads/`; use persistent storage and regular
database and media backups when deploying.

The app creates its database collections and indexes automatically when the
backend connects, then stores records as users register, upload videos, follow
creators, save videos, watch videos, and join private calls. The main
collections are `users`, `videos`, `follows`, `watchhistories`, `savedvideos`,
`videoreactions`, `videoreports`, `meetings`, and `meetingparticipants`.
Database documents contain video metadata; the actual media files remain in
`backend/uploads/`.

At startup, the backend creates MongoDB indexes and migrates existing
`backend/data/users.json` account records and JSON video metadata sidecars.
Successfully migrated source files are retained with a `.migrated` suffix.
The backend does not start if MongoDB is unavailable or the migration fails.
The API rate-limits account attempts per IP.

## Upload and play videos

1. Open **Video library** from the home page.
2. Select **Upload a video**, choose an MP4, WebM, OGG, MOV, or M4V file up to
   1 GB, then enter its title, description, category, and tags. You can also
   add a JPG/PNG/WebP thumbnail, a WebVTT captions file, and alternate 360p,
   480p, 720p, or 1080p encodes.
3. Play it from the library. The player provides play/pause, volume, seeking,
   fullscreen, playback speed, captions, and picture-in-picture where the
   browser supports it. If alternate encodes were uploaded, viewers can switch
   between them without losing their playback position. The app does not
   transcode or generate quality variants.
4. Signed-in users can resume playback, like or dislike a video, save it for
   later, share a link (including the current position), and report it. Reports
   require sign-in and are limited to one per account per video. Videos remain
   visible and playable to visitors.

The backend stores videos under `backend/uploads/`, which is excluded from Git.
Local uploads remain across backend restarts. Deployments need persistent disk
storage mounted at that directory to keep videos across redeploys. Uploading
and playback use the same `/api` path, proxied by Vite in development.

Uploads are public and are not tied to accounts or moderation. Do not upload
private or copyrighted material unless you have permission. The 1 GB per-file
limit does not impose a total storage quota; configure hosting storage limits
before exposing this publicly.

## Broadcast and watch live

1. Start MongoDB-connected backend, MediaMTX, and Vite as described above.
   Sign in, open **Streamer**, enter a title/optional description/HTTPS
   thumbnail URL, and select **Start live**. Allow camera and microphone access.
2. Share the watch URL shown on the dashboard, or browse `/live`. Viewers use
   HLS.js in supported browsers and native HLS in Safari. A viewer session ID
   is reused across reconnects in the same tab; 20-second heartbeats update the
   concurrent count, and abandoned sessions expire after 60 seconds.
3. The dashboard reports concurrent viewers, peak concurrent viewers, and
   total viewer sessions separately. Select **Stop live** to close the WHIP
   publication, end the session, and notify viewers. Chat/comment events stay
   on the existing Socket.IO connection; video goes from the broadcaster to
   MediaMTX via WHIP, then from the HLS origin/CDN to viewers.
4. If the browser reloads during a live session, open Streamer and select
   **Reconnect broadcast**. If its camera was disconnected, the page requests
   camera access again. The dashboard does not expose publisher credentials to
   viewers; credentials are generated for the streamer and only their hash is
   persisted.

Existing `LiveSession` documents/collection data are kept in place and served
through the `LiveStream` model. A legacy active session receives its default
HLS URL from the backend; the owner must reconnect from the dashboard to
publish that session into MediaMTX. An old browser-to-browser broadcast cannot
be relayed by the new HLS pipeline.

Live comments are shared and persisted in MongoDB. Signed-in users comment as
their account; guests can choose a display name. Existing likes, creator
profiles, and follow links remain available on the watch page.

## MongoDB collections and environment

The existing User model is reused. Live broadcast metadata is stored in the
existing `livesessions` collection through the `LiveStream` model; viewer
heartbeats use `liveviewersessions`; live chat reuses the existing `comments`
collection through `LiveChatMessage`. Indexes are initialized by the backend.
Publisher secrets are SHA-256 hashed in MongoDB and are not returned by viewer
or public listing APIs.

Copy `backend/.env.example` to `backend/.env` and set `MONGODB_URI` and a
private `JWT_SECRET` of at least 32 bytes as described above. Defaults target
local MediaMTX. Set `LIVE_HLS_BASE_URL` and `LIVE_WHIP_BASE_URL` to HTTPS,
browser-reachable service URLs for deployment. Set `FRONTEND_ORIGINS` to a
comma-separated allowlist. `REDIS_URL` is optional for Socket.IO events across
multiple backend instances. Never commit either `.env` file.

## MediaMTX and 500-viewer deployment

The root `mediamtx.yml` is a local development configuration. It accepts
publisher authorization from `POST /api/live/mediamtx-auth`; only a valid,
stream-scoped publisher credential may publish to its stream path. The owner
can rotate it by reconnecting the broadcast.
The example allows all CORS origins for localhost. Restrict HLS and WHIP CORS
origins in production and put both HTTP listeners behind HTTPS. Set
`authHTTPAddress` to an internal HTTPS address for the backend when MediaMTX
and Node run on separate hosts; do not expose the MediaMTX admin/API ports.

For a public deployment:

* Run Node/Express, MongoDB, Redis (when using multiple Node instances), and
  MediaMTX on maintained hosts. Use a DNS name and HTTPS reverse proxy for the
  frontend, API, HLS, and WHIP endpoints. Set `LIVE_HLS_BASE_URL`,
  `LIVE_WHIP_BASE_URL`, and `FRONTEND_ORIGINS` in `backend/.env`.
* Make MediaMTX's WebRTC ICE UDP port `8189` reachable from the internet and
  set `webrtcAdditionalHosts` to its public IP/DNS. Forward TCP `8189` only if
  using the optional ICE TCP listener. The WHIP HTTP endpoint alone is not
  enough: the WebRTC media connection needs working ICE.
* Put a CDN in front of HLS for 500+ viewers. Configure it for live HLS:
  forward LL-HLS query strings, do not cache live playlists for long, cache
  immutable media segments appropriately, and preserve CORS headers. Do an
  end-to-end test through the CDN before release. Without a CDN, the MediaMTX
  host must serve every viewer's egress bandwidth.
* This MediaMTX configuration publishes one rendition; it does not transcode
  or create an adaptive-bitrate ladder. For ABR, provision a transcoder that
  publishes aligned renditions and a master playlist, or use a managed live
  service that supplies ingest, transcoding, HLS/CDN delivery, and viewer
  analytics. MediaMTX itself is open-source software; hosting and CDN traffic
  are not free. Check current regional rates for [Amazon IVS](https://aws.amazon.com/ivs/pricing/),
  [Mux](https://www.mux.com/pricing/video), or your chosen CDN/service before
  selecting a managed provider. At 500 viewers and 1.5 Mb/s per viewer,
  unshared delivery is about 338 GB/hour; actual cost depends on bitrate,
  watch duration, region, caching, and provider pricing.
* Use HTTPS-only secure cookies, secret rotation, firewall rules, persistent
  MongoDB backups, provider health monitoring, and rate-limited public APIs.
  Alert on failed WHIP ingest, HLS origin health, API/socket errors, viewer
  count changes, CPU, memory, and network egress. Do not rely on a developer
  tunnel as production infrastructure.

For an HTTPS test from a phone or other device, deploy the frontend, API,
MediaMTX HLS, and WHIP endpoints at reachable hostnames and set their public
URLs in the backend environment. The phone must be able to reach the HLS HTTPS
endpoint, WHIP HTTPS endpoint, and MediaMTX UDP ICE port. `localhost` and a
frontend-only tunnel are not cross-device streaming endpoints. Sign in/start
from the streamer device, open the copied `/viewer/<roomId>` URL on the other
device, and use browser autoplay controls if the phone blocks sound-on autoplay.

## 500-viewer load test

This exercises actual HLS playlists and media-segment downloads, not just
Socket.IO connections. Use a staging stream and a load-generator host with
enough network egress; execute only with permission to load-test the CDN and
origin.

1. Start a real camera broadcast and obtain its room ID from the watch URL.
2. Set `LIVE_ROOM_ID`, `API_BASE_URL`, and `LIVE_BASE_URL` on the load
   generator. Point `LIVE_BASE_URL` at the same public HLS/CDN endpoint used
   by viewers, not localhost when testing a remote deployment.
3. Run from the project root:

   ```powershell
   $env:LIVE_ROOM_ID = "<32-character-room-id>"
   $env:API_BASE_URL = "https://stream.example.com"
   $env:LIVE_BASE_URL = "https://hls.example.com"
   $env:VIEWERS = "500"
   $env:DURATION_SECONDS = "180"
   $env:RAMP_UP_SECONDS = "30"
   npm --prefix backend run load-test:live
   ```

   Use the deployed `mediamtx.yml` CDN/origin configuration. This script creates
   separate unique session IDs, ramps viewers in, fetches HLS playlists and
   current media resources, heartbeats every 20 seconds, and sends leaves.
   The JSON report includes playback-session success, startup/request p50/p95,
   segment success, downloaded bytes/average egress rate, errors, generator
   CPU, and generator memory. A non-zero exit code signals failed thresholds.
4. Separately monitor the MediaMTX origin and CDN during the full test:
   provider metrics or OS monitoring should record origin/CDN egress, CPU,
   memory, active connections, cache hit ratio, HTTP 4xx/5xx, packet loss,
   HLS startup and rebuffering, and network errors. The script's host CPU/load
   fields describe the generator machine, not remote server metrics; on
   Windows, `os.loadavg()` is not available and reports zeros. Capture server
   metrics from its monitoring provider/OS. Repeat at 100, 250, and 500 viewers
   before increasing the target. A successful HTTP load test is not a guarantee
   of video decode quality on real phones; run a separate real-device smoke test.

Creator profiles are available at `/creators/<username>` and show the creator's
bio, follower count, and uploaded videos. Likes and follows require signing in;
guests can still post comments with a display name.

Online video streaming requires a direct media-file URL from a host that allows
cross-origin access (CORS). Video-site page links such as YouTube URLs and
DRM-protected videos cannot be captured by the browser for rebroadcast.

## Invite a guest on another device

`localhost` refers to the device opening the link, so a guest on another device
cannot use a `localhost` invite link. For a secure cross-device test, keep the
backend and frontend running, then expose the frontend over HTTPS in a third
terminal:

```powershell
.\ngrok.exe http 5173
```

Copy the HTTPS URL printed by ngrok into `VITE_PUBLIC_APP_URL` in `.env`, add
that host to Vite's `server.allowedHosts` and the backend's `frontendOrigins`,
then restart Vite and the backend. Create a new private room and share the
invite link. The tunnel URL changes when a temporary ngrok tunnel restarts.
The Socket.IO connection uses the same HTTPS origin and Vite proxies it to the
backend. The guest's camera and microphone require HTTPS (localhost is the
exception). Do not share the invite link publicly.

## How private video rooms work

1. Choose **Create private call** on the home page. The browser creates a
   random 128-bit room ID and opens `/call/<room-id>`.
2. Allow camera and microphone access. If neither device is available, you can
   still join to receive other participants' media.
3. Choose **Copy invite link** and share it with up to three people.
4. Each guest opens that link, allows camera and microphone access, and joins.
   Alternatively, paste the invite link or room ID into the home page's join
   field.
5. The backend admits at most four connected users per room and relays
   participant-specific WebRTC offer, answer, and ICE signaling. Media travels
   peer-to-peer in a mesh, with one connection per participant pair.

The invite URL is a bearer link: anyone who has it can request access while the
room is open, so share it only with intended guests. New participants wait for
the host to admit them. Hosts can deny or remove participants, request mute or
unmute, and end the meeting; participants can raise/lower a hand, chat, and
share or stop sharing their screen. Optional meeting passwords are hashed by
the backend and are never included in invite links. Room settings exist only
while the backend process is running. Meeting history keeps the latest 20
private calls in the current browser's local storage.

If both camera and microphone are not available together, the app tries each
device independently so an audio-only or video-only call can still work. Local
camera, microphone, and screen access requires localhost or HTTPS. For
reliable calls across restrictive networks, configure a TURN relay. Set
`TURN_URLS` and `TURN_SHARED_SECRET` in `backend/.env` to the URLs and shared
secret of a TURN service that supports coturn REST/shared-secret authentication.
The backend returns short-lived (one-hour) credentials from `/api/ice-servers`;
the secret stays on the backend and is never bundled into the frontend. For
example:

```env
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
TURN_SHARED_SECRET=your-provider-shared-secret
```

Replace the example URLs and secret with the values from your TURN provider.
The TURN server/provider must be configured with the same shared secret and
allow the listed ports and transports. Restart the backend and frontend after
configuration. Without TURN settings, calls use STUN/direct connectivity only,
which may not work through some firewalls, carrier NATs, or restrictive
networks. TURN relays consume provider bandwidth and may incur charges. Mesh
calling uses more bandwidth and CPU as participants are added; use an SFU media
server for larger rooms.

## Existing livestream

The `/streamer` and `/viewer` routes continue to use the original livestream
signaling events independently of private call rooms.
