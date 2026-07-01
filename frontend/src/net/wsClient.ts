// WebSocket client to the game server. Supports two connection styles:
//  - local dev: ws://localhost:8080/play (no auth)
//  - MicroVM:   wss://<endpoint>/play with lambda-microvms.* subprotocols carrying
//               the auth token + target port (browsers can't set WS headers).

import {
  PROTOCOL_VERSION,
  decodeServer,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@game/shared';

export interface WsClientOptions {
  /** Full ws(s) URL, or undefined to build from endpoint. */
  url?: string;
  /** MicroVM proxy host (production). */
  endpoint?: string;
  /** Auth token for the subprotocol (production). */
  wsToken?: string;
  /** Target guest port (default 8080). */
  port?: number;
  onMessage: (msg: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
}

export class WsClient {
  private ws: WebSocket | null = null;

  constructor(private readonly opts: WsClientOptions) {}

  connect(): void {
    const { url, endpoint, wsToken, port = 8080 } = this.opts;
    let target: string;
    let protocols: string[] | undefined;

    if (url) {
      target = url; // local dev
    } else if (endpoint) {
      target = `wss://${endpoint}/play`;
      protocols = [
        'lambda-microvms',
        `lambda-microvms.authentication.${wsToken}`,
        `lambda-microvms.port.${port}`,
      ];
    } else {
      throw new Error('WsClient requires either url or endpoint');
    }

    const ws = protocols ? new WebSocket(target, protocols) : new WebSocket(target);
    this.ws = ws;
    ws.addEventListener('open', () => this.opts.onOpen());
    ws.addEventListener('close', () => this.opts.onClose());
    ws.addEventListener('message', (ev) => {
      const msg = decodeServer(typeof ev.data === 'string' ? ev.data : '');
      if (msg) this.opts.onMessage(msg);
    });
  }

  hello(playerId: string, name: string, hostSecret?: string): void {
    this.send({ t: 'hello', v: PROTOCOL_VERSION, playerId, name, hostSecret });
  }

  /** Host-only: start the round from the waiting room. */
  start(): void {
    this.send({ t: 'start' });
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  close(): void {
    this.ws?.close();
  }
}
