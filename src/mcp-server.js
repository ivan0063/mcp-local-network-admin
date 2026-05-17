import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { JenkinsClient } from './tools/jenkins.js';
import { HomeAssistantClient } from './tools/homeassistant.js';

const jenkins = new JenkinsClient();
const ha = new HomeAssistantClient();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(result) {
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
  };
}

function err(error) {
  return {
    content: [{ type: 'text', text: `Error: ${error.message}` }],
    isError: true,
  };
}

function tool(server, name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return err(e);
    }
  });
}

// ─── Factory: crea un McpServer con todas las tools registradas ───────────────

function createServer() {
  const server = new McpServer({
    name: 'mcp-local-network-admin',
    version: '2.0.0',
  });

  // ── Jenkins tools ────────────────────────────────────────────────────────────

  tool(server, 'jenkins_list_jobs',
    'Lista todos los jobs/pipelines de Jenkins con su estado actual. Soporta folders y multibranch.',
    {},
    () => jenkins.listJobs()
  );

  tool(server, 'jenkins_get_job_info',
    'Información detallada de un job: descripción, URL, parámetros y builds recientes.',
    { job_name: z.string().describe('Nombre exacto del job en Jenkins') },
    ({ job_name }) => jenkins.getJobInfo(job_name)
  );

  tool(server, 'jenkins_get_job_config',
    'Obtiene la configuración XML completa de un job, incluyendo el Jenkinsfile/pipeline script.',
    { job_name: z.string().describe('Nombre del job') },
    ({ job_name }) => jenkins.getJobConfig(job_name)
  );

  tool(server, 'jenkins_copy_job',
    'Crea un nuevo job copiando exactamente la configuración de uno existente.',
    {
      from_job: z.string().describe('Job origen (el que se copia)'),
      to_job: z.string().describe('Nombre del nuevo job a crear'),
    },
    ({ from_job, to_job }) => jenkins.copyJob(from_job, to_job)
  );

  tool(server, 'jenkins_create_job',
    'Crea un nuevo job con una configuración XML personalizada.',
    {
      job_name: z.string().describe('Nombre del nuevo job'),
      config_xml: z.string().describe('XML de configuración completo del job'),
    },
    ({ job_name, config_xml }) => jenkins.createJob(job_name, config_xml)
  );

  tool(server, 'jenkins_update_job_config',
    'Actualiza la configuración XML de un job existente.',
    {
      job_name: z.string().describe('Nombre del job a actualizar'),
      config_xml: z.string().describe('Nueva configuración XML'),
    },
    ({ job_name, config_xml }) => jenkins.updateJobConfig(job_name, config_xml)
  );

  tool(server, 'jenkins_delete_job',
    'Elimina permanentemente un job de Jenkins. Confirma con el usuario antes de llamar esta tool.',
    { job_name: z.string().describe('Nombre del job a eliminar') },
    ({ job_name }) => jenkins.deleteJob(job_name)
  );

  tool(server, 'jenkins_enable_job',
    'Habilita un job que estaba deshabilitado.',
    { job_name: z.string().describe('Nombre del job') },
    ({ job_name }) => jenkins.enableJob(job_name)
  );

  tool(server, 'jenkins_disable_job',
    'Deshabilita un job sin eliminarlo.',
    { job_name: z.string().describe('Nombre del job') },
    ({ job_name }) => jenkins.disableJob(job_name)
  );

  tool(server, 'jenkins_trigger_build',
    'Dispara un build para un job. Acepta parámetros opcionales.',
    {
      job_name: z.string().describe('Nombre del job a ejecutar'),
      parameters: z.record(z.string()).optional().describe('Parámetros del build como key-value, ej: {"BRANCH": "main"}'),
    },
    ({ job_name, parameters }) => jenkins.triggerBuild(job_name, parameters ?? {})
  );

  tool(server, 'jenkins_abort_build',
    'Aborta un build en curso.',
    {
      job_name: z.string().describe('Nombre del job'),
      build_number: z.union([z.string(), z.number()]).describe('Número de build a abortar'),
    },
    ({ job_name, build_number }) => jenkins.abortBuild(job_name, build_number)
  );

  tool(server, 'jenkins_get_build_status',
    'Obtiene el estado de un build: SUCCESS, FAILURE, RUNNING, etc.',
    {
      job_name: z.string().describe('Nombre del job'),
      build_number: z.string().default('lastBuild').describe('Número de build o "lastBuild"'),
    },
    ({ job_name, build_number }) => jenkins.getBuildStatus(job_name, build_number ?? 'lastBuild')
  );

  tool(server, 'jenkins_get_build_log',
    'Obtiene las últimas N líneas del log de un build (default 100).',
    {
      job_name: z.string().describe('Nombre del job'),
      build_number: z.string().default('lastBuild').describe('Número de build o "lastBuild"'),
      lines: z.number().int().positive().default(100).describe('Número de líneas desde el final'),
    },
    ({ job_name, build_number, lines }) => jenkins.getBuildLog(job_name, build_number ?? 'lastBuild', lines ?? 100)
  );

  tool(server, 'jenkins_get_build_stages',
    'Obtiene los stages de un pipeline y su resultado (requiere Pipeline Stage View plugin).',
    {
      job_name: z.string().describe('Nombre del job'),
      build_number: z.string().default('lastBuild').describe('Número de build o "lastBuild"'),
    },
    ({ job_name, build_number }) => jenkins.getBuildStages(job_name, build_number ?? 'lastBuild')
  );

  tool(server, 'jenkins_get_queue',
    'Muestra la cola de builds pendientes de ejecutarse.',
    {},
    () => jenkins.getQueue()
  );

  tool(server, 'jenkins_list_nodes',
    'Lista los nodos/agentes de Jenkins con su estado (online/offline) y ejecutores.',
    {},
    () => jenkins.listNodes()
  );

  tool(server, 'jenkins_get_job_parameters',
    'Obtiene los parámetros que acepta un job parametrizado (nombre, tipo, valor por defecto).',
    { job_name: z.string().describe('Nombre del job') },
    ({ job_name }) => jenkins.getJobParameters(job_name)
  );

  tool(server, 'jenkins_search_builds',
    'Busca builds de un job filtrando por resultado.',
    {
      job_name: z.string().describe('Nombre del job'),
      result: z.enum(['SUCCESS', 'FAILURE', 'UNSTABLE', 'ABORTED']).describe('Resultado a filtrar'),
      limit: z.number().int().positive().default(20).describe('Máximo de builds a revisar'),
    },
    ({ job_name, result, limit }) => jenkins.searchBuilds(job_name, result, limit ?? 20)
  );

  // ── Home Assistant tools ─────────────────────────────────────────────────────

  tool(server, 'ha_get_all_entities',
    'Lista todas las entidades de Home Assistant con su estado actual (resumen).',
    {},
    () => ha.getAllStates()
  );

  tool(server, 'ha_get_entities_by_domain',
    'Lista entidades filtradas por tipo/dominio. Más eficiente que traer todo.',
    {
      domain: z.string().describe('Dominio: light, switch, climate, sensor, binary_sensor, automation, scene, script, media_player, cover, fan, person'),
    },
    ({ domain }) => ha.getEntitiesByDomain(domain)
  );

  tool(server, 'ha_get_entity_state',
    'Obtiene el estado completo y todos los atributos de una entidad específica.',
    {
      entity_id: z.string().describe('ID de la entidad, ej: light.sala, climate.ac_habitacion'),
    },
    ({ entity_id }) => ha.getEntityState(entity_id)
  );

  tool(server, 'ha_call_service',
    `Controla dispositivos llamando a un servicio de HA.
Ejemplos:
- Encender luz: domain=light, service=turn_on, service_data={"entity_id":"light.sala","brightness":200}
- Ajustar temp: domain=climate, service=set_temperature, service_data={"entity_id":"climate.ac","temperature":22}
- Toggle múltiples: service_data={"entity_id":["light.sala","light.cocina"]}`,
    {
      domain: z.string().describe('Dominio: light, switch, climate, scene, automation, media_player, etc.'),
      service: z.string().describe('Servicio: turn_on, turn_off, toggle, set_temperature, etc.'),
      service_data: z.record(z.unknown()).optional().describe('Datos del servicio (entity_id casi siempre requerido)'),
    },
    ({ domain, service, service_data }) => ha.callService(domain, service, service_data ?? {})
  );

  tool(server, 'ha_get_automations',
    'Lista todas las automatizaciones y si están activas o no.',
    {},
    () => ha.getAutomations()
  );

  tool(server, 'ha_toggle_automation',
    'Activa o desactiva una automatización.',
    {
      entity_id: z.string().describe('ID de la automatización, ej: automation.luces_noche'),
      enable: z.boolean().describe('true para activar, false para desactivar'),
    },
    ({ entity_id, enable }) => ha.toggleAutomation(entity_id, enable)
  );

  tool(server, 'ha_trigger_automation',
    'Dispara una automatización manualmente.',
    {
      entity_id: z.string().describe('ID de la automatización'),
    },
    ({ entity_id }) => ha.triggerAutomation(entity_id)
  );

  tool(server, 'ha_get_scenes',
    'Lista todas las escenas configuradas en Home Assistant.',
    {},
    () => ha.getScenes()
  );

  tool(server, 'ha_activate_scene',
    'Activa una escena.',
    {
      entity_id: z.string().describe('ID de la escena, ej: scene.cine'),
    },
    ({ entity_id }) => ha.activateScene(entity_id)
  );

  tool(server, 'ha_get_scripts',
    'Lista todos los scripts de Home Assistant.',
    {},
    () => ha.getScripts()
  );

  tool(server, 'ha_run_script',
    'Ejecuta un script de Home Assistant.',
    {
      entity_id: z.string().describe('ID del script, ej: script.apagar_todo'),
      variables: z.record(z.unknown()).optional().describe('Variables opcionales para el script'),
    },
    ({ entity_id, variables }) => ha.runScript(entity_id, variables ?? {})
  );

  tool(server, 'ha_get_persons',
    'Lista personas/dispositivos y su estado de presencia (home/not_home).',
    {},
    () => ha.getPersons()
  );

  tool(server, 'ha_send_notification',
    'Envía una notificación via un servicio notify.* de Home Assistant.',
    {
      notify_service: z.string().describe('Nombre del servicio después de "notify.", ej: "mobile_app_iphone" o "all_devices"'),
      title: z.string().describe('Título de la notificación'),
      message: z.string().describe('Cuerpo de la notificación'),
      data: z.record(z.unknown()).optional().describe('Datos adicionales (url, image, etc.)'),
    },
    ({ notify_service, title, message, data }) => ha.sendNotification(notify_service, title, message, data ?? {})
  );

  tool(server, 'ha_control_media_player',
    'Controla un media player (play, pausa, volumen, fuente).',
    {
      entity_id: z.string().describe('ID del media player'),
      action: z.string().describe('Acción: media_play, media_pause, media_stop, volume_set, select_source, media_next_track, media_previous_track'),
      extra_data: z.record(z.unknown()).optional().describe('Datos extra, ej: {"volume_level": 0.5} o {"source": "Spotify"}'),
    },
    ({ entity_id, action, extra_data }) => ha.controlMediaPlayer(entity_id, action, extra_data ?? {})
  );

  tool(server, 'ha_get_entity_history',
    'Obtiene el historial de estados de una entidad en las últimas N horas.',
    {
      entity_id: z.string().describe('ID de la entidad'),
      hours_ago: z.number().positive().default(24).describe('Horas hacia atrás (default: 24)'),
    },
    ({ entity_id, hours_ago }) => ha.getEntityHistory(entity_id, hours_ago ?? 24)
  );

  tool(server, 'ha_get_logbook',
    'Obtiene la actividad reciente del logbook (qué cambió y cuándo).',
    {
      hours_ago: z.number().positive().default(24).describe('Horas hacia atrás (default: 24)'),
      entity_id: z.string().optional().describe('Filtrar por entidad específica (opcional)'),
    },
    ({ hours_ago, entity_id }) => ha.getLogbook(hours_ago ?? 24, entity_id ?? null)
  );

  tool(server, 'ha_fire_event',
    'Dispara un evento personalizado en el bus de eventos de Home Assistant.',
    {
      event_type: z.string().describe('Tipo de evento, ej: "my_custom_event"'),
      event_data: z.record(z.unknown()).optional().describe('Datos del evento'),
    },
    ({ event_type, event_data }) => ha.fireEvent(event_type, event_data ?? {})
  );

  tool(server, 'ha_get_config',
    'Obtiene la configuración global de HA: versión, timezone, unidades, ubicación.',
    {},
    () => ha.getConfig()
  );

  tool(server, 'ha_get_areas',
    'Obtiene las áreas/habitaciones configuradas en Home Assistant con sus entidades.',
    {},
    () => ha.getAreaRegistry()
  );

  tool(server, 'ha_get_dashboard',
    'Obtiene la configuración actual del dashboard Lovelace por defecto.',
    {},
    () => ha.getDashboard()
  );

  tool(server, 'ha_save_dashboard',
    'Guarda/reemplaza el dashboard Lovelace por defecto. Requiere que HA esté en modo storage.',
    {
      config: z.record(z.unknown()).describe('Configuración Lovelace completa en formato JSON'),
    },
    ({ config }) => ha.saveDashboard(config)
  );

  tool(server, 'ha_create_lovelace_dashboard',
    `Genera y guarda automáticamente un dashboard Lovelace completo basado en las entidades existentes.
Tipos disponibles:
- rooms: control por habitación, agrupado por áreas
- energy: sensores de energía y potencia con gráficas
- homekit: entidades compatibles con Apple HomeKit organizadas por tipo
- automations: panel de control de automatizaciones con toggles`,
    {
      type: z.enum(['rooms', 'energy', 'homekit', 'automations']).describe('Tipo de dashboard a generar'),
    },
    ({ type }) => ha.createLovelaceDashboard(type)
  );

  tool(server, 'ha_get_homekit_entities',
    'Lista todas las entidades compatibles con Apple HomeKit (luz, switch, clima, cerradura, etc.) con su estado.',
    {},
    () => ha.getHomekitEntities()
  );

  tool(server, 'ha_reset_homekit_accessory',
    'Resetea un accesorio en HomeKit Bridge para forzar su re-exposición a Apple Home.',
    {
      entity_id: z.string().describe('ID de la entidad a resetear en HomeKit'),
    },
    ({ entity_id }) => ha.resetHomekitAccessory(entity_id)
  );

  return server;
}

// ─── Sesiones stateful ────────────────────────────────────────────────────────

const transports = new Map(); // sessionId → { transport, server }

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const JENKINS_TOOLS = 18;
const HA_TOOLS = 24;

app.get('/', (_req, res) => {
  res.json({
    name: 'mcp-local-network-admin',
    version: '2.0.0',
    transport: 'StreamableHTTP',
    endpoint: '/mcp',
    tools: { jenkins: JENKINS_TOOLS, homeassistant: HA_TOOLS, total: JENKINS_TOOLS + HA_TOOLS },
    config: {
      jenkins: process.env.JENKINS_URL || 'not configured',
      homeassistant: process.env.HA_URL || 'not configured',
    },
  });
});

// POST /mcp — mensajes JSON-RPC (incluye initialize)
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let entry = sessionId ? transports.get(sessionId) : null;

  if (!entry) {
    // Nueva sesión: solo si es un initialize
    if (!isInitializeRequest(req.body)) {
      return res.status(400).json({ error: 'Sesión no encontrada. Envía initialize primero.' });
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, { transport, server });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  await entry.transport.handleRequest(req, res, req.body);
});

// GET /mcp — SSE streaming (server-initiated messages)
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const entry = sessionId ? transports.get(sessionId) : null;
  if (!entry) return res.status(404).send('Sesión no encontrada.');
  await entry.transport.handleRequest(req, res);
});

// DELETE /mcp — cierre explícito de sesión
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const entry = sessionId ? transports.get(sessionId) : null;
  if (!entry) return res.status(404).send('Sesión no encontrada.');
  await entry.transport.handleRequest(req, res);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`\n✅ MCP Local Network Admin v2.0.0`);
  console.log(`   Endpoint MCP:   http://localhost:${PORT}/mcp`);
  console.log(`   Health check:   http://localhost:${PORT}/`);
  console.log(`   Tools:          ${JENKINS_TOOLS} Jenkins + ${HA_TOOLS} Home Assistant = ${JENKINS_TOOLS + HA_TOOLS} total`);
  console.log(`   Jenkins:        ${process.env.JENKINS_URL || '⚠️  no configurado (JENKINS_URL)'}`);
  console.log(`   Home Assistant: ${process.env.HA_URL || '⚠️  no configurado (HA_URL)'}\n`);
  console.log(`   Agregar a Claude Code:`);
  console.log(`   claude mcp add --transport http local-network-admin http://localhost:${PORT}/mcp\n`);
});

process.on('SIGINT', async () => {
  for (const { transport } of transports.values()) {
    await transport.close().catch(() => {});
  }
  process.exit(0);
});
