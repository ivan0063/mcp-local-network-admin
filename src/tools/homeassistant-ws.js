import WebSocket from 'ws';

/**
 * Cliente WebSocket de Home Assistant.
 * Muchas operaciones de configuración (registries, lovelace, recorder, backups,
 * helpers) ya no existen como endpoints REST en versiones modernas de HA —
 * solo se exponen via la API WebSocket (/api/websocket).
 *
 * Documentación: https://developers.home-assistant.io/docs/api/websocket/
 */
export class HomeAssistantWebSocketClient {
  constructor(httpBaseUrl, token) {
    this.url = `${httpBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/api/websocket`;
    this.token = token;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connecting = null;
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let authed = false;

      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        } else if (msg.type === 'auth_ok') {
          authed = true;
          this.ws = ws;
          this.connecting = null;
          resolve();
        } else if (msg.type === 'auth_invalid') {
          this.connecting = null;
          reject(new Error(`Home Assistant WebSocket auth failed: ${msg.message}`));
          ws.close();
        } else if (msg.type === 'result' || msg.type === 'event') {
          this._handleMessage(msg);
        }
      });

      ws.addEventListener('error', () => {
        if (!authed) {
          this.connecting = null;
          reject(new Error(`No se pudo conectar al WebSocket de Home Assistant en ${this.url}`));
        }
      });

      ws.addEventListener('close', () => {
        this.ws = null;
        if (!authed) {
          this.connecting = null;
          reject(new Error('Home Assistant cerró el WebSocket antes de autenticar'));
          return;
        }
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('Se perdió la conexión WebSocket con Home Assistant'));
        }
        this.pending.clear();
      });
    });

    return this.connecting;
  }

  _handleMessage(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending || msg.type !== 'result') return;
    this.pending.delete(msg.id);
    if (msg.success) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(`Home Assistant [${msg.error?.code}]: ${msg.error?.message}`));
    }
  }

  /** Envía un comando WebSocket y espera su resultado. */
  async command(type, payload = {}) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}
