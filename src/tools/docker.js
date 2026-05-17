import Docker from 'dockerode';
import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Docker Client
 * Usa dockerode para la API de Docker y docker compose CLI para stacks.
 *
 * Requiere acceso al socket Docker:
 *   - Nativo: /var/run/docker.sock (auto-detectado)
 *   - Remoto: variable DOCKER_HOST=tcp://host:2376
 *   - En Docker: montar -v /var/run/docker.sock:/var/run/docker.sock
 */
export class DockerClient {
  constructor() {
    this.docker = process.env.DOCKER_HOST
      ? new Docker({ host: process.env.DOCKER_HOST })
      : new Docker();
  }

  // ─── Sistema ──────────────────────────────────────────────────

  async systemInfo() {
    const [info, version] = await Promise.all([
      this.docker.info(),
      this.docker.version(),
    ]);
    return {
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

  async listImages() {
    const images = await this.docker.listImages({ all: false });
    return images.map(img => ({
      id: img.Id.slice(7, 19),
      tags: img.RepoTags ?? ['<none>'],
      size: `${Math.round(img.Size / 1024 / 1024)} MB`,
      created: new Date(img.Created * 1000).toISOString(),
    }));
  }

  async pullImage(image) {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        const lines = [];
        stream.on('data', chunk => {
          String(chunk).split('\n').filter(Boolean).forEach(line => {
            try { const d = JSON.parse(line); if (d.status) lines.push(d.status); } catch {}
          });
        });
        stream.on('end', () => resolve({ success: true, image, log: [...new Set(lines)] }));
        stream.on('error', reject);
      });
    });
  }

  async removeImage(imageId, force = false) {
    const image = this.docker.getImage(imageId);
    await image.remove({ force });
    return { success: true, removed: imageId };
  }

  async purgeImages(mode = 'dangling') {
    // dangling: solo imágenes sin tag (<none>:<none>)
    // unused: todas las imágenes no usadas por ningún contenedor
    const filters = mode === 'dangling'
      ? { dangling: { true: true } }
      : {};

    const result = await this.docker.pruneImages({ filters });
    return {
      mode,
      images_deleted: result.ImagesDeleted ?? [],
      space_reclaimed: `${Math.round((result.SpaceReclaimed ?? 0) / 1024 / 1024)} MB`,
    };
  }

  // ─── Contenedores ─────────────────────────────────────────────

  async listContainers(all = true) {
    const containers = await this.docker.listContainers({ all });
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

  async inspectContainer(nameOrId) {
    const c = this.docker.getContainer(nameOrId);
    const data = await c.inspect();
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

  async startContainer(nameOrId) {
    const c = this.docker.getContainer(nameOrId);
    await c.start();
    return { success: true, action: 'started', container: nameOrId };
  }

  async stopContainer(nameOrId, timeout = 10) {
    const c = this.docker.getContainer(nameOrId);
    await c.stop({ t: timeout });
    return { success: true, action: 'stopped', container: nameOrId };
  }

  async restartContainer(nameOrId, timeout = 10) {
    const c = this.docker.getContainer(nameOrId);
    await c.restart({ t: timeout });
    return { success: true, action: 'restarted', container: nameOrId };
  }

  async removeContainer(nameOrId, force = false) {
    const c = this.docker.getContainer(nameOrId);
    await c.remove({ force });
    return { success: true, action: 'removed', container: nameOrId };
  }

  async containerLogs(nameOrId, lines = 100) {
    const c = this.docker.getContainer(nameOrId);
    const logBuffer = await c.logs({ stdout: true, stderr: true, tail: lines, timestamps: true });
    // dockerode returns a Buffer with multiplexed stream headers — limpiar
    return logBuffer.toString('utf8')
      .split('\n')
      .map(line => line.slice(8))  // remove 8-byte stream header
      .join('\n')
      .trim();
  }

  async containerStats(nameOrId) {
    const c = this.docker.getContainer(nameOrId);
    const stats = await c.stats({ stream: false });

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100 : 0;

    const memUsage = stats.memory_stats.usage - (stats.memory_stats.stats?.cache ?? 0);
    const memLimit = stats.memory_stats.limit;

    return {
      container: nameOrId,
      cpu_percent: `${cpuPercent.toFixed(2)}%`,
      memory_usage: `${Math.round(memUsage / 1024 / 1024)} MB`,
      memory_limit: `${Math.round(memLimit / 1024 / 1024)} MB`,
      memory_percent: `${((memUsage / memLimit) * 100).toFixed(2)}%`,
      network_rx: stats.networks ? `${Math.round(Object.values(stats.networks).reduce((a, n) => a + n.rx_bytes, 0) / 1024)} KB` : 'n/a',
      network_tx: stats.networks ? `${Math.round(Object.values(stats.networks).reduce((a, n) => a + n.tx_bytes, 0) / 1024)} KB` : 'n/a',
    };
  }

  // ─── Docker Compose ───────────────────────────────────────────

  /**
   * Levanta un stack desde un YAML de compose.
   * Requiere docker compose CLI disponible en el host.
   */
  async composeUp(projectName, composeYaml, { pull = false, build = false } = {}) {
    const tmpFile = join(tmpdir(), `mcp-compose-${Date.now()}.yml`);
    try {
      writeFileSync(tmpFile, composeYaml, 'utf8');
      const args = ['compose', '-p', projectName, '-f', tmpFile, 'up', '-d'];
      if (pull) args.push('--pull', 'always');
      if (build) args.push('--build');
      const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 120_000 });
      return { success: true, project: projectName, output: (stdout + stderr).trim() };
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Baja un stack de compose por nombre de proyecto.
   */
  async composeDown(projectName, { removeVolumes = false, removeImages = false } = {}) {
    const args = ['compose', '-p', projectName, 'down'];
    if (removeVolumes) args.push('-v');
    if (removeImages) args.push('--rmi', 'all');
    const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 60_000 });
    return { success: true, project: projectName, output: (stdout + stderr).trim() };
  }

  /**
   * Lista los stacks de compose activos en el sistema.
   */
  async listComposeStacks() {
    try {
      const { stdout } = await execFileAsync('docker', ['compose', 'ls', '--format', 'json']);
      return JSON.parse(stdout);
    } catch {
      // docker compose ls no disponible en versiones viejas — fallback con labels
      const containers = await this.docker.listContainers({ all: true });
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
}
