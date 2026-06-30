// Client bootstrap with three entry flows:
//   1. ?server=ws://...   local dev — connect straight to a local game server.
//   2. ?room=<id>         guest — join a shared link with no login.
//   3. (default)          host — log in, pick a mode, create a room, share the link.

import { GAME_MODES, MODE_LABELS, type GameMode, type ServerMessage } from '@game/shared';
import { WsClient } from './net/wsClient.js';
import { InputSampler } from './input/sampler.js';
import { SnapshotBuffer } from './render/interp.js';
import { Renderer } from './render/canvas.js';
import { TokenRefresher } from './net/tokenRefresh.js';
import { clearSession, loadSession, saveSession, type Session } from './net/session.js';
import * as api from './net/api.js';

const params = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;

let myPlayerId = 'host';

// ---- Connection drivers ----

interface PlayConfig {
  // Either a local url, or an endpoint+token pair (MicroVM).
  url?: string;
  endpoint?: string;
  wsToken?: string;
  name: string;
  playerId: string;
  refresher?: TokenRefresher;
  // Host-only controls (waiting room Start + End game / terminate).
  isHost?: boolean;
  roomId?: string;
  hostToken?: string;
  /** Per-room secret proving host authority on the gameplay WS (host only). */
  hostSecret?: string;
  /** Persisted so a refresh resumes the same room as the same identity. */
  session?: Session;
  /** Called after the host ends the game (returns host to the lobby). */
  onEnded?: () => void;
}

function startGame(cfg: PlayConfig): void {
  $('lobby').style.display = 'none';
  $('game').style.display = 'block';
  $('hostbar').style.display = 'flex'; // may have been hidden by a prior End game
  myPlayerId = cfg.playerId;
  let ended = false;

  // Persist the session so a browser refresh resumes this exact room + identity.
  if (cfg.session) saveSession(cfg.session);

  const buffer = new SnapshotBuffer();
  const renderer = new Renderer($('canvas') as HTMLCanvasElement, () => myPlayerId);
  let currentToken = cfg.wsToken;
  let activeClient: WsClient | null = null;
  // One sampler per game session — re-pointed at each (re)connected client. A
  // fresh sampler per reconnect would stack key listeners and 60Hz send loops.
  const sampler = new InputSampler();

  // Keep currentToken fresh so reconnects (and the next refresh) use a live token.
  cfg.refresher?.onToken((wsToken) => {
    currentToken = wsToken;
  });

  const connect = () => {
    sampler.stop(); // detach from any prior socket before reconnecting
    activeClient?.close();
    const client = new WsClient({
      url: cfg.url,
      endpoint: cfg.endpoint,
      wsToken: currentToken,
      onOpen: () => {
        client.hello(cfg.playerId, cfg.name, cfg.hostSecret);
        sampler.start(client);
      },
      onClose: () => {
        sampler.stop();
        if (!ended) setStatus('Disconnected. Reconnecting…', () => setTimeout(connect, 1500));
      },
      onMessage: (msg: ServerMessage) => {
        if (msg.t === 'welcome') myPlayerId = msg.playerId;
        else if (msg.t === 'snapshot') {
          buffer.push(msg.snapshot, performance.now());
          updateHud(msg.snapshot.phase);
        } else if (msg.t === 'bye') {
          // Terminal: the room is gone or we're not allowed. Don't auto-reconnect,
          // and drop the stale session so a refresh returns to the lobby.
          ended = true;
          sampler.stop();
          clearSession();
          setStatus(`Disconnected: ${msg.reason}`);
        }
      },
    });
    activeClient = client;
    client.connect();
  };

  // --- Host/waiting-room HUD ---
  const startBtn = $('start-game') as HTMLButtonElement;
  const endBtn = $('end-game') as HTMLButtonElement;
  const waitMsg = $('wait-msg');
  let lastPhase = '';

  function updateHud(phase: string): void {
    if (phase !== lastPhase) {
      lastPhase = phase;
      const inLobby = phase === 'lobby';
      // Start button: host only, only while waiting.
      startBtn.style.display = cfg.isHost && inLobby ? 'inline-block' : 'none';
      // Waiting message: everyone, only while waiting.
      waitMsg.style.display = inLobby ? 'block' : 'none';
      waitMsg.textContent = cfg.isHost
        ? 'Waiting room — share the link, then press Start.'
        : 'Waiting for the host to start…';
    }
  }

  if (cfg.isHost) {
    startBtn.onclick = () => activeClient?.start();
    // End game: terminate the MicroVM via the control plane, then stop.
    endBtn.style.display = 'inline-block';
    endBtn.onclick = async () => {
      if (!cfg.roomId || !cfg.hostToken) return;
      if (!confirm('End the game for everyone and shut down the room?')) return;
      ended = true;
      try {
        await api.closeRoom(cfg.roomId, cfg.hostToken);
      } catch {
        /* VM may already be gone */
      }
      cfg.refresher?.clear();
      clearSession(); // room is gone; a refresh should land in the lobby
      activeClient?.close();
      // Tear down the game view and host controls, then return to the lobby.
      $('share').style.display = 'none';
      $('hostbar').style.display = 'none';
      startBtn.style.display = 'none';
      endBtn.style.display = 'none';
      waitMsg.style.display = 'none';
      $('game').style.display = 'none';
      lastPhase = '';
      cfg.onEnded?.();
    };
  }

  // Keep the token fresh for reconnects.
  cfg.refresher?.schedule(Date.now() + 50 * 60 * 1000);
  connect();

  const frame = () => {
    const snap = buffer.sample(performance.now());
    if (snap) renderer.render(snap);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function setStatus(text: string, then?: () => void): void {
  const el = $('status');
  el.textContent = text;
  el.style.display = 'block';
  then?.();
}

// ---- Flow 1: local dev ----
function localFlow(serverUrl: string): void {
  showLobby('local');
  ($('play') as HTMLButtonElement).onclick = () => {
    startGame({
      url: serverUrl,
      name: ($('name') as HTMLInputElement).value.trim() || 'Player',
      playerId: `local-${crypto.randomUUID().slice(0, 8)}`,
    });
  };
}

// ---- Flow 2: guest join ----
function guestFlow(roomId: string): void {
  showLobby('guest');
  ($('play') as HTMLButtonElement).onclick = async () => {
    const name = ($('name') as HTMLInputElement).value.trim() || 'Player';
    try {
      setStatus('Joining room…');
      const join = await api.joinRoom(roomId, name);
      $('status').style.display = 'none';
      const refresher = new TokenRefresher(roomId, join.guestJwt);
      startGame({
        endpoint: join.endpoint,
        wsToken: join.wsToken,
        name,
        playerId: join.guestId,
        refresher,
        session: {
          kind: 'guest',
          roomId,
          endpoint: join.endpoint,
          mode: join.mode,
          name,
          guestId: join.guestId,
          guestJwt: join.guestJwt,
        },
      });
    } catch (err) {
      setStatus(`Join failed: ${(err as Error).message}`);
    }
  };
}

// ---- Flow 3: host ----
function hostFlow(): void {
  showLobby('host');
  const modeSel = $('mode') as HTMLSelectElement;
  for (const m of GAME_MODES) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = MODE_LABELS[m];
    modeSel.appendChild(opt);
  }

  ($('login') as HTMLButtonElement).onclick = async () => {
    const username = ($('username') as HTMLInputElement).value.trim();
    const password = ($('password') as HTMLInputElement).value;
    try {
      setStatus('Logging in…');
      const { token } = await api.login(username, password);
      $('status').style.display = 'none';
      $('login-box').style.display = 'none';
      showCreateScreen(token);
    } catch (err) {
      setStatus(`Login failed: ${(err as Error).message}`);
    }
  };
}

/** Show the create-room screen for a logged-in host. Reused on first login and
 *  when the host ends a game and returns to the lobby (still authenticated). */
function showCreateScreen(token: string): void {
  $('game').style.display = 'none';
  $('lobby').style.display = 'block';
  $('login-box').style.display = 'none';
  $('create-box').style.display = 'block';

  ($('create') as HTMLButtonElement).onclick = async () => {
    const mode = ($('mode') as HTMLSelectElement).value as GameMode;
    const name = ($('host-name') as HTMLInputElement).value.trim() || 'Host';
    try {
      setStatus('Starting room… (booting MicroVM)');
      const room = await api.createRoom(token, mode);
      await waitForRoom(room.roomId);
      $('status').style.display = 'none';
      showShareLink(room.joinUrl);
      const refresher = new TokenRefresher(room.roomId, token);
      startGame({
        endpoint: room.endpoint,
        wsToken: room.wsToken,
        name,
        playerId: 'host',
        refresher,
        isHost: true,
        roomId: room.roomId,
        hostToken: token,
        hostSecret: room.hostSecret,
        session: {
          kind: 'host',
          roomId: room.roomId,
          endpoint: room.endpoint,
          mode,
          name,
          hostToken: token,
          hostSecret: room.hostSecret,
        },
        onEnded: () => showCreateScreen(token),
      });
    } catch (err) {
      setStatus(`Create failed: ${(err as Error).message}`);
    }
  };
}

/** Poll status until the room is reachable (host UX while the VM boots). */
async function waitForRoom(roomId: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const s = await api.getRoomStatus(roomId);
      if (s.status === 'RUNNING' || s.status === 'STARTING') {
        // STARTING is fine — the WS connect retries until the VM answers.
        if (i >= 2) return;
      }
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function showShareLink(joinUrl: string): void {
  const el = $('share');
  el.style.display = 'flex';
  el.innerHTML = `
    <span>🔗 Invite players:</span>
    <input id="share-url" readonly value="${joinUrl}">
    <button id="copy-link">Copy</button>`;
  const input = $('share-url') as HTMLInputElement;
  input.addEventListener('focus', () => input.select());
  ($('copy-link') as HTMLButtonElement).addEventListener('click', async () => {
    input.select();
    try {
      await navigator.clipboard.writeText(joinUrl);
      ($('copy-link') as HTMLButtonElement).textContent = 'Copied!';
    } catch {
      document.execCommand('copy'); // fallback for non-secure contexts
      ($('copy-link') as HTMLButtonElement).textContent = 'Copied!';
    }
    setTimeout(() => {
      const b = document.getElementById('copy-link');
      if (b) b.textContent = 'Copy';
    }, 1500);
  });
}

function showLobby(flow: 'host' | 'guest' | 'local'): void {
  $('lobby').style.display = 'block';
  $('login-box').style.display = flow === 'host' ? 'block' : 'none';
  $('create-box').style.display = 'none';
  $('join-box').style.display = flow === 'host' ? 'none' : 'block';
  $('flow-title').textContent =
    flow === 'host' ? 'Host a game' : flow === 'guest' ? 'Join the game' : 'Local play';
}

// ---- Resume after refresh ----
// Re-mint a WS token for the saved room (its short-lived token wasn't stored) and
// reconnect with the SAME identity: host stays host (secret + Cognito token kept);
// a guest keeps their guestId, so the server treats it as a reconnect and their
// ship/score persist. If the room is gone, drop the session and fall back.
async function resumeFlow(s: Session, fallback: () => void): Promise<void> {
  // Keep the lobby (and its login box) HIDDEN during resume so the host doesn't
  // see the login screen flash. Show only a neutral reconnecting overlay.
  $('lobby').style.display = 'none';
  setStatus('Reconnecting to your game…');
  try {
    const status = await api.getRoomStatus(s.roomId);
    if (status.status === 'CLOSED' || status.status === 'TERMINATED') {
      throw new Error('room closed');
    }
    const authJwt = s.kind === 'host' ? s.hostToken : s.guestJwt;
    const { wsToken } = await api.refreshToken(s.roomId, authJwt);
    $('status').style.display = 'none';

    const refresher = new TokenRefresher(s.roomId, authJwt);
    if (s.kind === 'host') {
      showShareLink(`${location.origin}/?room=${s.roomId}`);
      startGame({
        endpoint: s.endpoint, wsToken, name: s.name, playerId: 'host', refresher,
        isHost: true, roomId: s.roomId, hostToken: s.hostToken, hostSecret: s.hostSecret,
        session: s, onEnded: () => showCreateScreen(s.hostToken),
      });
    } else {
      startGame({
        endpoint: s.endpoint, wsToken, name: s.name, playerId: s.guestId, refresher, session: s,
      });
    }
  } catch {
    clearSession();
    setStatus('Your previous game has ended.');
    fallback();
  }
}

// ---- Entry ----
const serverUrl = params.get('server');
const roomId = params.get('room');
const saved = loadSession();

if (serverUrl) {
  localFlow(serverUrl);
} else if (saved) {
  // A refresh: resume the saved room. Fall back to the URL-appropriate flow.
  void resumeFlow(saved, () => (roomId ? guestFlow(roomId) : hostFlow()));
} else if (roomId) {
  guestFlow(roomId);
} else {
  hostFlow();
}
