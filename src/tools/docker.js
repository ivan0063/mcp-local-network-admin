import Docker from 'dockerode';
import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Docker Client — soporta múltiples hosts remotos vía Docker REST API.
 *
 * Conexión local (default):  socket /var/run/docker.sock o DOCKER_HOST env
 * Conexión remota:           docker_connect con host:port del servidor
 *
 * Para exponer la API REST en un lab server (Linux):
 *   Editar /lib/systemd/system/docker.service:
 *   ExecStart=... -H tcp://0.0.0.0:2375 -H unix:///var/run/docker.sock
 *   systemctl daemon-reload && systemctl restart docker
 */
export class DockerClient {
  constructor() {
    // 'local' siempre disponible — usa socket local o DOCKER_HOST
    this.connections = new Map([
      ['local', { docker: new Docker(), label: 'local (socket)' }],
    ]);
  }

  // ─── Gestión de conexiones ────────────────────────────────────

  async connect(name, host, port = 2375, protocol = 'http') {
    const docker = new Docker({ host, port, protocol });
    // Verificar conectividad antes de registrar
    const version = await docker.version();
    this.connections.set(name, { docker, label: `${protocol}://${host}:${port}` });
    return {
      success: true,
      connection: name,
      host: `${protocol}://${host}:${port}`,
      docker_version: version.Version,
      os: version.Os,
      arch: version.Arch,
    };
  }

  disconnect(name) {
    if (name === 'local') throw new Error("La conexión 'local' no se puede eliminar.");
    if (!this.connections.has(name)) throw new Error(`Conexión '${name}' no encontrada.`);
    this.connections.delete(name);
    return { success: true, removed: name };
  }

  listConnections() {
    return [...this.connections.entries()].map(([name, { label }]) => ({ name, host: label }));
  }

  _get(connection = 'local') {
    const entry = this.connections.get(connection);
    if (!entry) throw new Error(`Conexión Docker '${connection}' no encontrada. Usa docker_connect primero.`);
    return entry.docker;
  }

  // ─── Sistema ──────────────────────────────────────────────────

  async systemInfo(connection = 'local') {
    const docker = this._get(connection);
    const [info, version] = await Promise.all([docker.info(), docker.version()]);
    return {
      connection,
      host: this.connections.get(connection).label,
      version: version.Version,
      api_version: version.ApiVersion,
      os: info.OperatingSystem,
      architecture: info.Architecture,
      cpus: info.NCPU,
      memory: `${Math.round(info.MemTotal / 1024 / 1024 / 1024)} GB`,
      containers: { total: info.Containers, running: info.ContainersRunning, stopped: info.ContainersStopped },
      images: info.Images,
      docker_root: info.DockerRootDir,
    };
  }

  // ─── Imágenes ─────────────────────────────────────────────────

  async listImages(connection = 'local') {
    const docker = this._get(connection);
    const images = await docker.listImages({ all: false });
    return images.map(img => ({
      id: img.Id.slice(7, 19),
      tags: img.RepoTags ?? ['<none>'],
      size: `${Math.round(img.Size / 1024 / 1024)} MB`,
      created: new Date(img.Created * 1000).toISOString(),
    }));
  }

  async pullImage(image, connection = 'local') {
    const docker = this._get(connection);
    return new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        const lines = [];
        stream.on('data', chunk => {
          String(chunk).split('\n').filter(Boolean).forEach(line => {
            try { const d = JSON.parse(line); if (d.status) lines.push(d.status); } catch {}
          });
        });
        stream.on('end', () => resolve({ success: true, image, connection, log: [...new Set(lines)] }));
        stream.on('error', reject);
      });
    });
  }

  async removeImage(imageId, force = false, connection = 'local') {
    const docker = this._get(connection);
    await docker.getImage(imageId).remove({ force });
    return { success: true, removed: imageId, connection };
  }

  async purgeImages(mode = 'dangling', connection = 'local') {
    const docker = this._get(connection);
    const filters = mode === 'dangling' ? { dangling: { true: true } } : {};
    const result = await docker.pruneImages({ filters });
    return {
      connection,
      mode,
      images_deleted: result.ImagesDeleted ?? [],
      space_reclaimed: `${Math.round((result.SpaceReclaimed ?? 0) / 1024 / 1024)} MB`,
    };
  }

  // ─── Contenedores ─────────────────────────────────────────────

  async listContainers(all = true, connection = 'local') {
    const docker = this._get(connection);
    const containers = await docker.listContainers({ all });
    return containers.map(c => ({
      id: c.Id.slice(0, 12),
      names: c.Names.map(n => n.replace(/^\//, '')),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports.map(p => p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`),
      created: new Date(c.Created * 1000).toISOString(),
    }));
  }

  async inspectContainer(nameOrId, connection = 'local') {
    const docker = this._get(connection);
    const data = await docker.getContainer(nameOrId).inspect();
    return {
      id: data.Id.slice(0, 12),
      name: data.Name.replace(/^\//, ''),
      image: data.Config.Image,
      state: data.State,
      created: data.Created,
      restart_policy: data.HostConfig.RestartPolicy,
      ports: data.NetworkSettings.Ports,
      env: data.Config.Env,
      mounts: data.Mounts.map(m => `${m.Source}:${m.Destination}`),
      network: Object.keys(data.NetworkSettings.Networks),
    };
  }

  async startContainer(nameOrId, connection = 'local') {
    await this._get(connection).getContainer(nameOrId).start();
    return { success: true, action: 'started', container: nameOrId, connection };
  }

  async stopContainer(nameOrId, timeout = 10, connection = 'local') {
    await this._get(connection).getContainer(nameOrId).stop({ t: timeout });
    return { success: true, action: 'stopped', container: nameOrId, connection };
  }

  async restartContainer(nameOrId, timeout = 10, connection = 'local') {
    await this._get(connection).getContainer(nameOrId).restart({ t: timeout });
    return { success: true, action: 'restarted', container: nameOrId, connection };
  }

  async removeContainer(nameOrId, force = false, connection = 'local') {
    await this._get(connection).getContainer(nameOrId).remove({ force });
    return { success: true, action: 'removed', container: nameOrId, connection };
  }

  async containerLogs(nameOrId, lines = 100, connection = 'local') {
    const buf = await this._get(connection).getContainer(nameOrId).logs({
      stdout: true, stderr: true, tail: lines, timestamps: true,
    });
    return buf.toString('utf8').split('\n').map(l => l.slice(8)).join('\n').trim();
  }

  async containerStats(nameOrId, connection = 'local') {
    const stats = await this._get(connection).getContainer(nameOrId).stats({ stream: false });
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100 : 0;
    const memUsage = stats.memory_stats.usage - (stats.memory_stats.stats?.cache ?? 0);
    const memLimit = stats.memory_stats.limit;
    return {
      container: nameOrId,
      connection,
      cpu_percent: `${cpuPercent.toFixed(2)}%`,
      memory_usage: `${Math.round(memUsage / 1024 / 1024)} MB`,
      memory_limit: `${Math.round(memLimit / 1024 / 1024)} MB`,
      memory_percent: `${((memUsage / memLimit) * 100).toFixed(2)}%`,
      network_rx: stats.networks ? `${Math.round(Object.values(stats.networks).reduce((a, n) => a + n.rx_bytes, 0) / 1024)} KB` : 'n/a',
      network_tx: stats.networks ? `${Math.round(Object.values(stats.networks).reduce((a, n) => a + n.tx_bytes, 0) / 1024)} KB` : 'n/a',
    };
  }

  // ─── Docker Compose ───────────────────────────────────────────

  async composeUp(projectName, composeYaml, { pull = false, build = false, host = null, port = 2375 } = {}) {
    const tmpFile = join(tmpdir(), `mcp-compose-${Date.now()}.yml`);
    try {
      writeFileSync(tmpFile, composeYaml, 'utf8');
      const args = ['compose', '-p', projectName, '-f', tmpFile, 'up', '-d'];
      if (pull) args.push('--pull', 'always');
      if (build) args.push('--build');
      const env = host ? { ...process.env, DOCKER_HOST: `tcp://${host}:${port}` } : process.env;
      const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 120_000, env });
      return { success: true, project: projectName, host: host ?? 'local', output: (stdout + stderr).trim() };
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  async composeDown(projectName, { removeVolumes = false, removeImages = false, host = null, port = 2375 } = {}) {
    const args = ['compose', '-p', projectName, 'down'];
    if (removeVolumes) args.push('-v');
    if (removeImages) args.push('--rmi', 'all');
    const env = host ? { ...process.env, DOCKER_HOST: `tcp://${host}:${port}` } : process.env;
    const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 60_000, env });
    return { success: true, project: projectName, host: host ?? 'local', output: (stdout + stderr).trim() };
  }

  async listComposeStacks(connection = 'local') {
    const connEntry = this.connections.get(connection);
    if (!connEntry) throw new Error(`Conexión '${connection}' no encontrada.`);

    try {
      // Intentar con docker compose ls si es conexión local
      if (connection === 'local') {
        const { stdout } = await execFileAsync('docker', ['compose', 'ls', '--format', 'json']);
        return JSON.parse(stdout);
      }
    } catch {}

    // Fallback: inferir stacks desde labels de contenedores
    const docker = connEntry.docker;
    const containers = await docker.listContainers({ all: true });
    const projects = new Map();
    for (const c of containers) {
      const project = c.Labels?.['com.docker.compose.project'];
      if (project) {
        if (!projects.has(project)) projects.set(project, { name: project, services: [], status: c.State });
        projects.get(project).services.push(c.Names[0]?.replace(/^\//, ''));
      }
    }
    return [...projects.values()];
  }
}
