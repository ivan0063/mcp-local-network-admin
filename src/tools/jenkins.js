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
      const res = await this.request('/crumbIssuer/api/json');
      const data = await res.json();
      return { [data.crumbRequestField]: data.crumb };
    } catch {
      return {};
    }
  }

  // ─── Listar y explorar ────────────────────────────────────────

  /**
   * Lista todos los jobs con su estado y último build.
   * Soporta folders y multibranch pipelines de forma recursiva.
   */
  async listJobs(basePath = '') {
    const path = `${basePath}/api/json?tree=jobs[name,url,color,description,_class,lastBuild[number,result,timestamp,duration,url]]`;
    const res = await this.request(path);
    const data = await res.json();

    const folderClasses = [
      'com.cloudbees.hudson.plugins.folder.Folder',
      'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject',
      'jenkins.branch.OrganizationFolder',
    ];

    const results = [];
    for (const job of data.jobs ?? []) {
      const jobPath = basePath ? `${basePath}/job/${enc(job.name)}` : `/job/${enc(job.name)}`;
      if (folderClasses.some(c => job._class === c)) {
        const children = await this.listJobs(jobPath).catch(() => []);
        for (const child of children) {
          results.push({ ...child, path: `${job.name}/${child.path ?? child.name}` });
        }
      } else {
        results.push({ ...job, path: job.name });
      }
    }
    return results;
  }

  /** Información detallada de un job incluyendo parámetros definidos */
  async getJobInfo(jobName) {
    const res = await this.request(
      `/job/${enc(jobName)}/api/json?tree=name,description,url,color,buildable,` +
      `property[_class,parameterDefinitions[name,type,defaultParameterValue[value],description]],` +
      `lastBuild[*],builds[number,result,timestamp]{0,5}`
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

  /** Log de un build — por defecto las últimas 100 líneas */
  async getBuildLog(jobName, buildNumber = 'lastBuild', lines = 100) {
    const res = await this.request(
      `/job/${enc(jobName)}/${buildNumber}/consoleText`
    );
    const text = await res.text();
    return text.split('\n').slice(-lines).join('\n');
  }

  /** Stages de un pipeline via wfapi (requiere Pipeline Stage View plugin) */
  async getBuildStages(jobName, buildNumber = 'lastBuild') {
    const res = await this.request(
      `/job/${enc(jobName)}/${buildNumber}/wfapi/describe`
    );
    return res.json();
  }

  // ─── Crear y modificar jobs ───────────────────────────────────

  /**
   * Crea un Pipeline job con script Groovy inline.
   * Genera el XML correcto para WorkflowJob sin que el caller lo conozca.
   */
  async createPipelineJob(jobName, { script, description = '', parameters = [] } = {}) {
    const paramsDefs = parameters.map(p => {
      switch (p.type) {
        case 'string':
          return `<hudson.model.StringParameterDefinition>
              <name>${p.name}</name>
              <description>${p.description ?? ''}</description>
              <defaultValue>${p.default ?? ''}</defaultValue>
              <trim>false</trim>
            </hudson.model.StringParameterDefinition>`;
        case 'boolean':
          return `<hudson.model.BooleanParameterDefinition>
              <name>${p.name}</name>
              <description>${p.description ?? ''}</description>
              <defaultValue>${p.default ?? false}</defaultValue>
            </hudson.model.BooleanParameterDefinition>`;
        case 'choice':
          return `<hudson.model.ChoiceParameterDefinition>
              <name>${p.name}</name>
              <description>${p.description ?? ''}</description>
              <choices class="java.util.Arrays$ArrayList">
                <a class="string-array">${(p.choices ?? []).map(c => `<string>${c}</string>`).join('')}</a>
              </choices>
            </hudson.model.ChoiceParameterDefinition>`;
        default:
          return '';
      }
    }).filter(Boolean);

    const propertiesXml = paramsDefs.length > 0
      ? `<properties>
          <hudson.model.ParametersDefinitionProperty>
            <parameterDefinitions>${paramsDefs.join('\n')}</parameterDefinitions>
          </hudson.model.ParametersDefinitionProperty>
        </properties>`
      : '<properties/>';

    const configXml = `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>${description}</description>
  <keepDependencies>false</keepDependencies>
  ${propertiesXml}
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">
    <script>${escapeXml(script)}</script>
    <sandbox>true</sandbox>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>`;

    return this.createJob(jobName, configXml);
  }

  /**
   * Crea un Pipeline job que lee el Jenkinsfile desde un repositorio Git.
   */
  async createPipelineJobFromRepo(jobName, {
    repoUrl,
    branch = 'main',
    credentialsId = '',
    scriptPath = 'Jenkinsfile',
    description = '',
    parameters = [],
  } = {}) {
    const paramsDefs = parameters.map(p => {
      switch (p.type) {
        case 'string':
          return `<hudson.model.StringParameterDefinition>
              <name>${p.name}</name>
              <description>${p.description ?? ''}</description>
              <defaultValue>${p.default ?? ''}</defaultValue>
              <trim>false</trim>
            </hudson.model.StringParameterDefinition>`;
        case 'boolean':
          return `<hudson.model.BooleanParameterDefinition>
              <name>${p.name}</name>
              <description>${p.description ?? ''}</description>
              <defaultValue>${p.default ?? false}</defaultValue>
            </hudson.model.BooleanParameterDefinition>`;
        case 'choice':
          return `<hudson.model.ChoiceParameterDefinition>
              <name>${p.name}</name>
              <description>${p.description ?? ''}</description>
              <choices class="java.util.Arrays$ArrayList">
                <a class="string-array">${(p.choices ?? []).map(c => `<string>${c}</string>`).join('')}</a>
              </choices>
            </hudson.model.ChoiceParameterDefinition>`;
        default:
          return '';
      }
    }).filter(Boolean);

    const propertiesXml = paramsDefs.length > 0
      ? `<properties>
          <hudson.model.ParametersDefinitionProperty>
            <parameterDefinitions>${paramsDefs.join('\n')}</parameterDefinitions>
          </hudson.model.ParametersDefinitionProperty>
        </properties>`
      : '<properties/>';

    const credXml = credentialsId
      ? `<credentialsId>${credentialsId}</credentialsId>`
      : '<credentialsId/>';

    const configXml = `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>${description}</description>
  <keepDependencies>false</keepDependencies>
  ${propertiesXml}
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
    <scm class="hudson.plugins.git.GitSCM" plugin="git">
      <configVersion>2</configVersion>
      <userRemoteConfigs>
        <hudson.plugins.git.UserRemoteConfig>
          <url>${repoUrl}</url>
          ${credXml}
        </hudson.plugins.git.UserRemoteConfig>
      </userRemoteConfigs>
      <branches>
        <hudson.plugins.git.BranchSpec>
          <name>*/${branch}</name>
        </hudson.plugins.git.BranchSpec>
      </branches>
      <doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations>
      <submoduleCfg class="empty-list"/>
      <extensions/>
    </scm>
    <scriptPath>${scriptPath}</scriptPath>
    <lightweight>true</lightweight>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>`;

    return this.createJob(jobName, configXml);
  }

  /**
   * Copia un job existente como base para uno nuevo.
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

  /** Crea un job desde XML */
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

  // ─── Ejecutar y controlar builds ──────────────────────────────

  /**
   * Dispara un build. Acepta parámetros opcionales.
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

  /** Aborta un build en curso */
  async abortBuild(jobName, buildNumber) {
    const crumb = await this.getCrumb();
    await this.request(`/job/${enc(jobName)}/${buildNumber}/stop`, {
      method: 'POST',
      headers: crumb,
    });
    return { success: true, message: `Build #${buildNumber} de '${jobName}' abortado` };
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

  // ─── Cola y nodos ─────────────────────────────────────────────

  /** Ver la cola de builds pendientes */
  async getQueue() {
    const res = await this.request(
      '/queue/api/json?tree=items[id,task[name,url],why,blocked,stuck,buildableStartMilliseconds]'
    );
    return res.json();
  }

  /** Listar nodos/agentes con su estado */
  async listNodes() {
    const res = await this.request(
      '/computer/api/json?tree=computer[displayName,description,offline,temporarilyOffline,numExecutors,busyExecutors,assignedLabels[name]]'
    );
    return res.json();
  }

  // ─── Parámetros y búsqueda ────────────────────────────────────

  /** Obtiene los parámetros que acepta un job parametrizado */
  async getJobParameters(jobName) {
    const info = await this.getJobInfo(jobName);
    const paramsProp = info.property?.find(p =>
      p._class?.includes('ParametersDefinitionProperty')
    );
    return paramsProp?.parameterDefinitions ?? [];
  }

  /** Busca builds de un job filtrando por resultado */
  async searchBuilds(jobName, result, limit = 20) {
    const res = await this.request(
      `/job/${enc(jobName)}/api/json?tree=builds[number,result,timestamp,duration,url]{0,${limit}}`
    );
    const data = await res.json();
    return data.builds.filter(b => b.result === result.toUpperCase());
  }
}

const enc = (s) => encodeURIComponent(s);

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');
