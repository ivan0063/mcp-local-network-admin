import { Client } from 'ssh2';
import { readFileSync } from 'node:fs';

/**
 * SSH Client — conexiones nombradas a servidores remotos.
 * Credenciales solo en memoria (nunca en disco).
 *
 * Soporta autenticación por contraseña o por clave privada.
 */
export class SshClient {
  constructor() {
    this.connections = new Map(); // name → { config, label }
  }

  // ─── Gestión de conexiones ─────────────────────────────────────

  register(name, { host, port = 22, username, password, privateKey, passphrase }) {
    if (!host || !username) throw new Error('host y username son requeridos.');
    if (!password && !privateKey) throw new Error('Se requiere password o privateKey.');
    const config = { host, port, username };
    if (password) config.password = password;
    if (privateKey) {
      config.privateKey = privateKey;
      if (passphrase) config.passphrase = passphrase;
    }
    this.connections.set(name, { config, label: `${username}@${host}:${port}` });
    return { success: true, name, host: `${username}@${host}:${port}` };
  }

  unregister(name) {
    if (!this.connections.has(name)) throw new Error(`Conexión SSH '${name}' no encontrada.`);
    this.connections.delete(name);
    return { success: true, removed: name };
  }

  listConnections() {
    return [...this.connections.entries()].map(([name, { label }]) => ({ name, host: label }));
  }

  _getConfig(name) {
    const entry = this.connections.get(name);
    if (!entry) throw new Error(`Conexión SSH '${name}' no encontrada. Registra primero con ssh_connect.`);
    return entry.config;
  }

  // ─── Primitiva de conexión ─────────────────────────────────────

  _connect(config) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.destroy();
        reject(new Error(`Timeout conectando a ${config.host}:${config.port ?? 22}`));
      }, 10_000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        resolve(conn);
      });
      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      conn.connect(config);
    });
  }

  // ─── Ejecución de comandos ─────────────────────────────────────

  async exec(connectionName, command, { timeout = 60_000 } = {}) {
    const config = this._getConfig(connectionName);
    const conn = await this._connect(config);
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); return reject(err); }

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          conn.destroy();
          reject(new Error(`Comando superó el timeout de ${timeout}ms`));
        }, timeout);

        stream.on('close', (code) => {
          clearTimeout(timer);
          conn.end();
          resolve({ exit_code: code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
        stream.on('data', (data) => { stdout += data; });
        stream.stderr.on('data', (data) => { stderr += data; });
      });
    });
  }

  // ─── Transferencia de archivos ─────────────────────────────────

  async upload(connectionName, localPath, remotePath) {
    const config = this._getConfig(connectionName);
    const conn = await this._connect(config);
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        sftp.fastPut(localPath, remotePath, (err2) => {
          conn.end();
          if (err2) return reject(err2);
          resolve({ success: true, local: localPath, remote: remotePath });
        });
      });
    });
  }

  async download(connectionName, remotePath, localPath) {
    const config = this._getConfig(connectionName);
    const conn = await this._connect(config);
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        sftp.fastGet(remotePath, localPath, (err2) => {
          conn.end();
          if (err2) return reject(err2);
          resolve({ success: true, remote: remotePath, local: localPath });
        });
      });
    });
  }

  async readRemoteFile(connectionName, remotePath) {
    const config = this._getConfig(connectionName);
    const conn = await this._connect(config);
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        const chunks = [];
        const stream = sftp.createReadStream(remotePath);
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => { conn.end(); resolve(Buffer.concat(chunks).toString('utf8')); });
        stream.on('error', (err2) => { conn.end(); reject(err2); });
      });
    });
  }

  async writeRemoteFile(connectionName, remotePath, content) {
    const config = this._getConfig(connectionName);
    const conn = await this._connect(config);
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        const stream = sftp.createWriteStream(remotePath);
        stream.on('close', () => { conn.end(); resolve({ success: true, remote: remotePath, bytes: Buffer.byteLength(content) }); });
        stream.on('error', (err2) => { conn.end(); reject(err2); });
        stream.end(content);
      });
    });
  }

  // ─── Conveniencia ──────────────────────────────────────────────

  async getSystemInfo(connectionName) {
    const [uname, cpu, mem, disk, uptime, os] = await Promise.all([
      this.exec(connectionName, 'uname -a'),
      this.exec(connectionName, "grep -c ^processor /proc/cpuinfo 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 'N/A'"),
      this.exec(connectionName, "free -h 2>/dev/null || vm_stat 2>/dev/null | head -5"),
      this.exec(connectionName, 'df -h / 2>/dev/null'),
      this.exec(connectionName, 'uptime'),
      this.exec(connectionName, 'cat /etc/os-release 2>/dev/null | head -5 || sw_vers 2>/dev/null || uname -s'),
    ]);
    return {
      uname: uname.stdout,
      cpus: cpu.stdout,
      memory: mem.stdout,
      disk: disk.stdout,
      uptime: uptime.stdout,
      os: os.stdout,
    };
  }

  async listProcesses(connectionName, filter = '') {
    const cmd = filter
      ? `ps aux 2>/dev/null | grep -v grep | grep '${filter.replace(/'/g, "'\\''")}'`
      : 'ps aux 2>/dev/null | head -30';
    const result = await this.exec(connectionName, cmd);
    return result.stdout;
  }

  async tailLog(connectionName, logPath, lines = 50) {
    const result = await this.exec(connectionName, `tail -n ${lines} "${logPath.replace(/"/g, '\\"')}"`);
    return result.stdout || result.stderr;
  }

  async checkPorts(connectionName) {
    const result = await this.exec(connectionName, 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null');
    return result.stdout;
  }
}
