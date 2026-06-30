// Gameplay WebSocket server (port 8080, path /play). The MicroVM proxy strips the
// lambda-microvms.* subprotocols before the upgrade reaches us, so we see a clean
// connection here and identify the player from the app-level `hello` message —
// the auth token only proves "allowed to reach this VM's port 8080".

import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_PLAYERS_PER_ROOM,
  PROTOCOL_VERSION,
  TICK_RATE,
  decodeClient,
  encode,
  rulesetFor,
  type ServerMessage,
} from '@game/shared';
import type { World, SimEvent } from '../sim/world.js';
import { GameLoop } from '../sim/loop.js';
import { Rng } from '../sim/rng.js';
import { World as WorldImpl } from '../sim/world.js';
import type { RunState } from '../hooks/runState.js';

interface Conn {
  ws: WebSocket;
  playerId: string | null;
  /** True only if this connection proved host authority via the room's secret. */
  isHost: boolean;
  /** Set when a newer connection for the same playerId has taken over. */
  superseded: boolean;
}

export class GameServer {
  private wss: WebSocketServer | null = null;
  // World + loop are created in applyRunState(), NOT the constructor. This is
  // deliberate: the constructor runs before the MicroVM snapshot is captured, so
  // drawing the RNG seed here would bake one shared seed into every room. The
  // seed arrives via the /run hook (a fresh CSPRNG draw per VM).
  private world: World | null = null;
  private loop: GameLoop | null = null;
  private run: RunState | null = null;
  private readonly conns = new Set<Conn>();
  /** The current live connection per playerId (for refresh/reconnect handover). */
  private readonly byPlayer = new Map<string, Conn>();

  /** Start accepting connections. Safe to call before run state exists. */
  listen(port: number): void {
    this.wss = new WebSocketServer({ port, path: '/play' });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    console.log(`[game] ws listening on :${port}/play (awaiting run state)`);
  }

  /** Apply the room's mode + seed (from /run, or env in local dev) and start the loop. */
  applyRunState(run: RunState): void {
    this.run = run;
    const ruleset = rulesetFor(run.mode);
    this.world = new WorldImpl(ruleset, new Rng(run.seed), () => Date.now());
    this.loop = new GameLoop(this.world, {
      onSnapshot: () => this.broadcastSnapshot(),
      onEvents: (events) => this.broadcastEvents(events),
    });
    this.loop.start();
    console.log(`[game] run state applied mode=${run.mode} room=${run.roomId}`);
  }

  /** True once the engine is constructed and listening — used by the /ready hook. */
  isReady(): boolean {
    return this.wss !== null;
  }

  /** For /resume: draw a fresh CSPRNG seed so post-resume randomness diverges. */
  reseed(): void {
    this.world?.reseed(Rng.freshSeed());
  }

  /** Warm the hot code paths for the /validate hook (snapshot prefetch). */
  validateMockTick(): void {
    const ruleset = rulesetFor('coop');
    const mock = new WorldImpl(ruleset, new Rng(1), () => Date.now());
    mock.addPlayer('validate-bot', 'bot');
    mock.setInput('validate-bot', { seq: 1, thrust: true, rotate: 1, fire: true });
    for (let i = 0; i < 3; i++) mock.step(1 / 30);
    mock.snapshot();
  }

  playerCount(): number {
    return this.world?.playerCount() ?? 0;
  }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws, playerId: null, isHost: false, superseded: false };
    this.conns.add(conn);

    ws.on('message', (raw) => {
      const msg = decodeClient(raw.toString());
      if (!msg) return;

      if (msg.t === 'hello') {
        if (msg.v !== PROTOCOL_VERSION) {
          this.send(ws, { t: 'bye', reason: 'protocol-version-mismatch' });
          ws.close();
          return;
        }
        // Gameplay can't begin until /run has delivered the room's mode + seed.
        if (!this.world || !this.run) {
          this.send(ws, { t: 'bye', reason: 'room-not-ready' });
          ws.close();
          return;
        }
        // Capacity gate is enforced here (authoritative), closing the join race
        // that the control-plane soft count can't fully prevent.
        if (conn.playerId === null && this.world.playerCount() >= MAX_PLAYERS_PER_ROOM) {
          this.send(ws, { t: 'bye', reason: 'room-full' });
          ws.close();
          return;
        }
        // Host authority is proved by the per-room secret, NOT by the client
        // claiming playerId:'host'. The secret is delivered only to the room
        // creator via /run; guests never have it. Without a configured secret
        // (e.g. local dev), fall back to the playerId convention.
        const secret = this.run.hostSecret;
        conn.isHost = secret
          ? msg.hostSecret === secret
          : msg.playerId === 'host';
        // The 'host' identity is reserved for the secret-holder. A non-host that
        // claims it (forged or accidental) is rejected so it can't collide with
        // the host's ship. Legitimate guests use their own guestId.
        if (!conn.isHost && msg.playerId === 'host') {
          this.send(ws, { t: 'bye', reason: 'host-identity-reserved' });
          ws.close();
          return;
        }
        conn.playerId = conn.isHost ? 'host' : msg.playerId;

        // Handover: if this player already has a live connection (a refresh
        // racing the old socket's close), retire the old one without evicting the
        // player, so its later 'close' won't remove the freshly-reconnected ship.
        const prior = this.byPlayer.get(conn.playerId);
        if (prior && prior !== conn) {
          prior.superseded = true;
          this.send(prior.ws, { t: 'bye', reason: 'superseded' });
          prior.ws.close();
        }
        this.byPlayer.set(conn.playerId, conn);

        this.world.addPlayer(conn.playerId, msg.name.slice(0, 24) || 'Player');
        this.send(ws, {
          t: 'welcome',
          v: PROTOCOL_VERSION,
          playerId: conn.playerId,
          mode: this.run.mode,
          ruleset: rulesetFor(this.run.mode),
          tickRate: TICK_RATE,
        });
        return;
      }

      if (msg.t === 'input' && conn.playerId && this.world) {
        this.world.setInput(conn.playerId, {
          seq: msg.seq,
          thrust: msg.thrust,
          rotate: msg.rotate,
          fire: msg.fire,
        });
      }

      // Only a connection that proved host authority may start the round.
      if (msg.t === 'start' && conn.isHost && this.world) {
        this.world.start();
      }
    });

    ws.on('close', () => {
      this.conns.delete(conn);
      // A superseded socket (replaced by a reconnect) must not evict the player.
      if (conn.superseded) return;
      if (conn.playerId && this.byPlayer.get(conn.playerId) === conn) {
        this.byPlayer.delete(conn.playerId);
        this.world?.removePlayer(conn.playerId);
      }
    });
    ws.on('error', () => ws.close());
  }

  private broadcastSnapshot(): void {
    if (!this.world) return;
    const snapshot = this.world.snapshot();
    for (const conn of this.conns) {
      if (!conn.playerId) continue;
      this.send(conn.ws, {
        t: 'snapshot',
        ackSeq: this.world.ackSeqFor(conn.playerId),
        snapshot,
      });
    }
  }

  private broadcastEvents(events: SimEvent[]): void {
    for (const e of events) {
      const msg: ServerMessage = { t: 'event', kind: e.kind, data: e.data };
      for (const conn of this.conns) {
        if (conn.playerId) this.send(conn.ws, msg);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(encode(msg));
  }
}
