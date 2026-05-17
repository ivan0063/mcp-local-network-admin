/**
 * Jenkins Client
 * Interactúa con la API REST de Jenkins.
 * Requiere: JENKINS_URL, JENKINS_USER, JENKINS_TOKEN en .env
 */
export class JenkinsClient {
  constructor() {
    this.baseUrl = (process.env.JENKINS_URL || '').replace(/\/$/, '');
    this.auth = Buffer.from(
      `${process.env.JENKINS_USER}:${process.env.JENKINS_TOKEN}`
    ).toString('base64');
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Basic ${this.auth}`,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jenkins ${res.status} en ${path}: ${body.slice(0, 200)}`);
    }

    return res;
  }

  /** Obtiene el crumb CSRF (requerido para POST en algunos Jenkins) */
  async getCrumb() {
    try {
      const res = await this.request(
        '/crumbIssuer/api/json?xpath=concat(//crumbRequestField,":",//crumb)'
      );
      const text = await res.text();
      const [field, value] = text.split(':');
      return { [field]: value };
    } catch {
      return {}; // Algunos Jenkins tienen CSRF deshabilitado
    }
  }

  // ─── Listar y explorar ────────────────────────────────────────

  /** Lista todos los jobs con su estado y último build */
  async listJobs() {
    const res = await this.request(
      '/api/json?tree=jobs[name,url,color,description,lastBuild[number,result,timestamp,duration,url]]'
    );
    return res.json();
  }

  /** Información detallada de un job */
  async getJobInfo(jobName) {
    const res = await this.request(
      `/job/${enc(jobName)}/api/json?tree=name,description,url,color,buildable,lastBuild[*],builds[number,result,timestamp]{0,5}`
    );
    return res.json();
  }

  /** Configuración XML completa de un job (pipeline script incluido) */
  async getJobConfig(jobName) {
    const res = await this.request(`/job/${enc(jobName)}/config.xml`);
    return res.text();
  }

  /** Estado del último build (o un build específico) */
  async getBuildStatus(jobName, buildNumber = 'lastBuild') {
    const res = await this.request(
      `/job/${enc(jobName)}/${buildNumber}/api/json`
    );
    return res.json();
  }

  /** Log completo de un build */
  async getBuildLog(jobName, buildNumber = 'lastBuild') {
    const res = await this.request(
      `/job/${enc(jobName)}/${buildNumber}/consoleText`
    );
    const text = await res.text();
    // Devolver solo las últimas 100 líneas para no saturar el contexto
    const lines = text.split('\n');
    return lines.slice(-100).join('\n');
  }

  // ─── Crear y modificar jobs ───────────────────────────────────

  /**
   * Copia un job existente como base para uno nuevo.
   * Es la forma más rápida de replicar un pipeline.
   */
  async copyJob(fromJob, toJob) {
    const crumb = await this.getCrumb();
    await this.request(
      `/createItem?name=${enc(toJob)}&mode=copy&from=${enc(fromJob)}`,
      { method: 'POST', headers: crumb }
    );
    return {
      success: true,
      message: `Job '${toJob}' creado como copia de '${fromJob}'`,
    };
  }

  /** Crea un job desde XML (útil para modificar la config antes de crear) */
  async createJob(jobName, configXml) {
    const crumb = await this.getCrumb();
    await this.request(`/createItem?name=${enc(jobName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', ...crumb },
      body: configXml,
    });
    return { success: true, message: `Job '${jobName}' creado exitosamente` };
  }

  /** Actualiza la configuración XML de un job existente */
  async updateJobConfig(jobName, configXml) {
    const crumb = await this.getCrumb();
    await this.request(`/job/${enc(jobName)}/config.xml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', ...crumb },
      body: configXml,
    });
    return { success: true, message: `Job '${jobName}' actualizado` };
  }

  /** Elimina un job */
  async deleteJob(jobName) {
    const crumb = await this.getCrumb();
    await this.request(`/job/${enc(jobName)}/doDelete`, {
      method: 'POST',
      headers: crumb,
    });
    return { success: true, message: `Job '${jobName}' eliminado` };
  }

  // ─── Ejecutar builds ──────────────────────────────────────────

  /**
   * Dispara un build. Acepta parámetros opcionales.
   * Si el job tiene parameters configurados, se usa buildWithParameters.
   */
  async triggerBuild(jobName, parameters = {}) {
    const crumb = await this.getCrumb();
    const hasParams = Object.keys(parameters).length > 0;

    if (hasParams) {
      const params = new URLSearchParams(parameters).toString();
      await this.request(
        `/job/${enc(jobName)}/buildWithParameters?${params}`,
        { method: 'POST', headers: crumb }
      );
    } else {
      await this.request(`/job/${enc(jobName)}/build`, {
        method: 'POST',
        headers: crumb,
      });
    }

    return {
      success: true,
      message: `Build disparado para '${jobName}'${hasParams ? ' con parámetros' : ''}`,
    };
  }

  /** Habilita un job deshabilitado */
  async enableJob(jobName) {
    const crumb = await this.getCrumb();
    await this.request(`/job/${enc(jobName)}/enable`, {
      method: 'POST',
      headers: crumb,
    });
    return { success: true, message: `Job '${jobName}' habilitado` };
  }

  /** Deshabilita un job */
  async disableJob(jobName) {
    const crumb = await this.getCrumb();
    await this.request(`/job/${enc(jobName)}/disable`, {
      method: 'POST',
      headers: crumb,
    });
    return { success: true, message: `Job '${jobName}' deshabilitado` };
  }
}

const enc = (s) => encodeURIComponent(s);
