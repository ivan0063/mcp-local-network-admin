import { connectAsync } from 'mqtt';

export class MqttClient {
  constructor() {
    this.brokers = new Map(); // name → config
  }

  // ─── Gestión de brokers ────────────────────────────────────────

  register(name, { host, port = 1883, username, password, tls = false, clientIdPrefix = 'mcp' }) {
    if (!host) throw new Error('host es requerido.');
    this.brokers.set(name, { host, port: Number(port), username, password, tls, clientIdPrefix });
    return { success: true, name, broker: `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}` };
  }

  unregister(name) {
    if (!this.brokers.has(name)) throw new Error(`Broker MQTT '${name}' no encontrado.`);
    this.brokers.delete(name);
    return { success: true, removed: name };
  }

  listBrokers() {
    return [...this.brokers.entries()].map(([name, { host, port, tls, username }]) => ({
      name,
      broker: `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`,
      username: username ?? null,
      auth: !!username,
      tls,
    }));
  }

  _getConfig(name) {
    const config = this.brokers.get(name);
    if (!config) throw new Error(`Broker MQTT '${name}' no encontrado. Registra primero con mqtt_connect.`);
    return config;
  }

  _buildOptions(config) {
    const clientId = `${config.clientIdPrefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const options = { clientId, clean: true };
    if (config.username) options.username = config.username;
    if (config.password) options.password = config.password;
    return options;
  }

  async _open(name, timeoutMs = 10_000) {
    const config = this._getConfig(name);
    const url = `${config.tls ? 'mqtts' : 'mqtt'}://${config.host}:${config.port}`;
    const options = { ...this._buildOptions(config), connectTimeout: timeoutMs };
    return connectAsync(url, options);
  }

  // ─── Operaciones ───────────────────────────────────────────────

  async testConnection(name) {
    const config = this._getConfig(name);
    const client = await this._open(name, 5_000);
    await client.endAsync();
    return {
      success: true,
      broker: `${config.tls ? 'mqtts' : 'mqtt'}://${config.host}:${config.port}`,
      message: 'Conexión exitosa al broker MQTT.',
    };
  }

  async publish(name, topic, payload, { qos = 0, retain = false } = {}) {
    const client = await this._open(name);
    try {
      await client.publishAsync(topic, String(payload), { qos, retain });
      return { success: true, topic, payload: String(payload), qos, retain };
    } finally {
      await client.endAsync();
    }
  }

  async publishJson(name, topic, data, { qos = 0, retain = false } = {}) {
    return this.publish(name, topic, JSON.stringify(data), { qos, retain });
  }

  async subscribe(name, topicPattern, { timeout = 5_000, maxMessages = 20, qos = 0 } = {}) {
    const client = await this._open(name);
    const messages = [];

    return new Promise((resolve, reject) => {
      let finished = false;

      const finish = async (extra = {}) => {
        if (finished) return;
        finished = true;
        try { await client.endAsync(true); } catch { /* ignore */ }
        resolve({ broker: name, topic: topicPattern, messages, count: messages.length, ...extra });
      };

      const timer = setTimeout(() => finish({ stopped_at: 'timeout' }), timeout);

      client.on('error', async (e) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { await client.endAsync(true); } catch { /* ignore */ }
        reject(e);
      });

      client.on('message', (topic, payload) => {
        messages.push({ topic, payload: payload.toString(), timestamp: new Date().toISOString() });
        if (messages.length >= maxMessages) {
          clearTimeout(timer);
          finish({ stopped_at: 'max_messages' });
        }
      });

      client.subscribeAsync(topicPattern, { qos }).catch((e) => {
        clearTimeout(timer);
        finish = () => {};
        finished = true;
        client.endAsync(true).catch(() => {}).finally(() => reject(e));
      });
    });
  }

  async getRetained(name, topic) {
    const result = await this.subscribe(name, topic, { timeout: 3_000, maxMessages: 1, qos: 0 });
    if (result.messages.length === 0) {
      return { topic, retained: null, message: 'No hay mensaje retenido en este topic.' };
    }
    return { topic, retained: result.messages[0].payload };
  }

  async clearRetained(name, topic) {
    const client = await this._open(name);
    try {
      await client.publishAsync(topic, '', { retain: true });
      return { success: true, topic, message: 'Mensaje retenido eliminado.' };
    } finally {
      await client.endAsync();
    }
  }

  async getBrokerStats(name, { timeout = 4_000 } = {}) {
    const result = await this.subscribe(name, '$SYS/#', { timeout, maxMessages: 200, qos: 0 });
    const stats = {};
    for (const { topic, payload } of result.messages) {
      const key = topic.replace('$SYS/broker/', '').replace(/\//g, '.');
      stats[key] = isNaN(payload) || payload.trim() === '' ? payload : Number(payload);
    }
    return { broker: name, stats, topics_received: result.messages.length };
  }

  async listTopics(name, { timeout = 4_000, maxMessages = 200 } = {}) {
    const result = await this.subscribe(name, '#', { timeout, maxMessages, qos: 0 });
    const topics = [...new Set(result.messages.map((m) => m.topic))].sort();
    return { broker: name, topics, count: topics.length, messages_sampled: result.messages.length };
  }

  async listClients(name) {
    const result = await this.subscribe(name, '$SYS/broker/clients/#', { timeout: 3_000, maxMessages: 20, qos: 0 });
    const clients = {};
    for (const { topic, payload } of result.messages) {
      const key = topic.replace('$SYS/broker/clients/', '');
      clients[key] = isNaN(payload) || payload.trim() === '' ? payload : Number(payload);
    }
    return { broker: name, clients };
  }
}
