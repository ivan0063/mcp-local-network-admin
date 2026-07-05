import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { JenkinsClient } from './tools/jenkins.js';
import { HomeAssistantClient } from './tools/homeassistant.js';
import { PostgresClient } from './tools/postgres.js';
import { DockerClient } from './tools/docker.js';
import { SshClient } from './tools/ssh.js';
import { AsusRouterClient } from './tools/asus-router.js';
import { MqttClient } from './tools/mqtt.js';

const jenkins = new JenkinsClient();
const ha = new HomeAssistantClient();
const pg = new PostgresClient();
const docker = new DockerClient();
const ssh = new SshClient();
const router = new AsusRouterClient();
const mqttClient = new MqttClient();

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

  tool(server, 'jenkins_create_pipeline_job',
    `Crea un Pipeline job en Jenkins con un script Groovy inline.
No requiere crear el item manualmente — lo crea completo desde cero.
Soporta parámetros opcionales de tipo string, boolean o choice.

Ejemplo de parámetros:
[
  {"name": "BRANCH", "type": "string", "default": "main", "description": "Rama a construir"},
  {"name": "DEPLOY", "type": "boolean", "default": false},
  {"name": "ENV", "type": "choice", "choices": ["dev", "staging", "prod"]}
]`,
    {
      job_name: z.string().describe('Nombre del nuevo job en Jenkins'),
      script: z.string().describe('Script Groovy del pipeline (contenido completo del Jenkinsfile)'),
      description: z.string().optional().describe('Descripción del job'),
      parameters: z.array(z.object({
        name: z.string(),
        type: z.enum(['string', 'boolean', 'choice']),
        description: z.string().optional(),
        default: z.union([z.string(), z.boolean()]).optional(),
        choices: z.array(z.string()).optional(),
      })).optional().describe('Parámetros del pipeline'),
    },
    ({ job_name, script, description, parameters }) =>
      jenkins.createPipelineJob(job_name, { script, description, parameters: parameters ?? [] })
  );

  tool(server, 'jenkins_create_pipeline_job_from_repo',
    `Crea un Pipeline job en Jenkins que lee el Jenkinsfile desde un repositorio Git.
No requiere crear el item manualmente — lo crea completo desde cero.
Ideal para apuntar a un repo existente que ya tiene su Jenkinsfile.`,
    {
      job_name: z.string().describe('Nombre del nuevo job en Jenkins'),
      repo_url: z.string().describe('URL del repositorio Git, ej: https://github.com/user/repo.git'),
      branch: z.string().default('main').describe('Rama a usar (default: main)'),
      credentials_id: z.string().optional().describe('ID de credencial Git configurada en Jenkins (opcional para repos públicos)'),
      script_path: z.string().default('Jenkinsfile').describe('Ruta al Jenkinsfile dentro del repo (default: Jenkinsfile)'),
      description: z.string().optional().describe('Descripción del job'),
      parameters: z.array(z.object({
        name: z.string(),
        type: z.enum(['string', 'boolean', 'choice']),
        description: z.string().optional(),
        default: z.union([z.string(), z.boolean()]).optional(),
        choices: z.array(z.string()).optional(),
      })).optional().describe('Parámetros del pipeline'),
    },
    ({ job_name, repo_url, branch, credentials_id, script_path, description, parameters }) =>
      jenkins.createPipelineJobFromRepo(job_name, {
        repoUrl: repo_url,
        branch: branch ?? 'main',
        credentialsId: credentials_id ?? '',
        scriptPath: script_path ?? 'Jenkinsfile',
        description,
        parameters: parameters ?? [],
      })
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

  tool(server, 'ha_get_system_health',
    'Muestra el estado de salud del sistema HA: core, base de datos, red, e integraciones con alertas.',
    {},
    () => ha.getSystemHealth()
  );

  tool(server, 'ha_render_template',
    `Renderiza una plantilla Jinja2 en Home Assistant y devuelve el resultado.
Imprescindible para testear condiciones y valores antes de usarlos en automatizaciones.
Ejemplos:
- "{{ states('sensor.temperatura') | float }}"
- "{{ now().hour >= 22 or now().hour < 7 }}"
- "{{ states.light | selectattr('state','eq','on') | list | count }}"`,
    {
      template: z.string().describe('Plantilla Jinja2 a renderizar'),
    },
    ({ template }) => ha.renderTemplate(template)
  );

  tool(server, 'ha_list_persistent_notifications',
    'Lista las notificaciones persistentes activas en el panel de Home Assistant.',
    {},
    () => ha.listPersistentNotifications()
  );

  tool(server, 'ha_create_persistent_notification',
    'Crea una notificación persistente visible en el panel de Home Assistant (no en el móvil).',
    {
      title: z.string().describe('Título de la notificación'),
      message: z.string().describe('Cuerpo de la notificación (soporta Markdown)'),
      notification_id: z.string().optional().describe('ID opcional para poder descartarla después. Si ya existe una con ese ID, la reemplaza.'),
    },
    ({ title, message, notification_id }) => ha.createPersistentNotification(title, message, notification_id ?? null)
  );

  tool(server, 'ha_dismiss_persistent_notification',
    'Descarta y elimina una notificación persistente del panel de Home Assistant.',
    {
      notification_id: z.string().describe('ID de la notificación a descartar'),
    },
    ({ notification_id }) => ha.dismissPersistentNotification(notification_id)
  );

  tool(server, 'ha_list_automation_configs',
    `Lista todas las automatizaciones con su configuración completa (triggers, conditions, actions).
A diferencia de ha_get_automations, devuelve el config JSON real de cada automatización, no solo el estado.
Requiere que HA esté en modo storage (predeterminado en versiones modernas).
El campo "id" de cada automatización es el que necesitas para actualizar o eliminar.`,
    {},
    () => ha.listAutomationConfigs()
  );

  tool(server, 'ha_get_automation_config',
    'Obtiene la configuración completa de una automatización específica por su unique_id.',
    {
      automation_id: z.string().describe('unique_id de la automatización (obtenlo con ha_list_automation_configs)'),
    },
    ({ automation_id }) => ha.getAutomationConfig(automation_id)
  );

  tool(server, 'ha_create_automation',
    `Crea una nueva automatización en Home Assistant.
El config debe ser un objeto JSON válido con la estructura de HA.

Ejemplo mínimo:
{
  "alias": "Apagar luces a medianoche",
  "trigger": [{"platform": "time", "at": "00:00:00"}],
  "action": [{"service": "light.turn_off", "target": {"entity_id": "all"}}],
  "mode": "single"
}

Plataformas de trigger comunes: time, state, numeric_state, sun, homeassistant, event, template
Modes: single, restart, queued, parallel`,
    {
      config: z.record(z.unknown()).describe('Configuración completa de la automatización como objeto JSON'),
    },
    ({ config }) => ha.createAutomation(config)
  );

  tool(server, 'ha_update_automation',
    `Actualiza una automatización existente. Reemplaza toda su configuración.
Primero usa ha_get_automation_config para obtener el config actual, modifícalo y pásalo aquí.`,
    {
      automation_id: z.string().describe('unique_id de la automatización (obtenlo con ha_list_automation_configs)'),
      config: z.record(z.unknown()).describe('Nueva configuración completa de la automatización'),
    },
    ({ automation_id, config }) => ha.updateAutomation(automation_id, config)
  );

  tool(server, 'ha_delete_automation',
    'Elimina permanentemente una automatización de Home Assistant. Esta acción no se puede deshacer.',
    {
      automation_id: z.string().describe('unique_id de la automatización (obtenlo con ha_list_automation_configs)'),
    },
    ({ automation_id }) => ha.deleteAutomation(automation_id)
  );

  tool(server, 'ha_list_entity_registry',
    `Lista el registro interno de entidades con su metadata: nombre override, área asignada,
icono, si está deshabilitada, plataforma de origen y device_id.
Más completo que ha_get_all_entities para tareas de organización.`,
    {
      domain: z.string().optional().describe('Filtrar por dominio: light, switch, sensor, etc. (opcional)'),
    },
    ({ domain }) => ha.listEntityRegistry(domain ?? null)
  );

  tool(server, 'ha_get_entity_registry_entry',
    'Obtiene la entrada completa del registro para una entidad específica.',
    {
      entity_id: z.string().describe('ID de la entidad'),
    },
    ({ entity_id }) => ha.getEntityRegistryEntry(entity_id)
  );

  tool(server, 'ha_update_entity_registry_entry',
    `Actualiza la entrada del registro de una entidad. Permite:
- Renombrar el nombre visible (friendly name override)
- Cambiar el entity_id (ej: light.lamp_1 → light.sala_lampara_esquina)
- Asignar a un área
- Deshabilitar/habilitar la entidad
- Cambiar el icono (ej: mdi:lightbulb-outline)
- Asignar categorías (por scope) y labels

Funciona igual para automatizaciones y scripts (automation.x, script.x), ya que son
entidades bajo el mismo registro — así se les asigna categoría/label/área.

Nota: cambiar el entity_id romperá las automatizaciones que lo referencien — actualízalas también.`,
    {
      entity_id: z.string().describe('ID actual de la entidad'),
      name: z.string().optional().nullable().describe('Nuevo nombre visible. null para usar el nombre del dispositivo.'),
      new_entity_id: z.string().optional().describe('Nuevo entity_id (ej: "light.sala_principal")'),
      area_id: z.string().optional().nullable().describe('ID del área a asignar. null para quitar el área.'),
      disabled: z.boolean().optional().describe('true para deshabilitar la entidad, false para habilitarla'),
      icon: z.string().optional().nullable().describe('Icono MDI, ej: "mdi:lightbulb". null para usar el default.'),
      categories: z.record(z.string().nullable()).optional()
        .describe('Categorías por scope, ej: {"automation": "cat_id"}. Usa ha_list_categories para ver los IDs. null en un scope para quitarla.'),
      labels: z.array(z.string()).optional().describe('Lista completa de label_ids a asignar (reemplaza las existentes). Usa ha_list_labels para ver los IDs.'),
    },
    ({ entity_id, name, new_entity_id, area_id, disabled, icon, categories, labels }) =>
      ha.updateEntityRegistryEntry(entity_id, { name, newEntityId: new_entity_id, areaId: area_id, disabled, icon, categories, labels })
  );

  tool(server, 'ha_list_device_registry',
    'Lista todos los dispositivos físicos con sus entidades, área asignada, fabricante y modelo.',
    {},
    () => ha.listDeviceRegistry()
  );

  tool(server, 'ha_list_helpers',
    `Lista los helpers creados en Home Assistant (input_boolean, input_number, input_select, input_text, counter, timer).
Si se omite domain, devuelve todos los tipos.`,
    {
      domain: z.enum(['input_boolean', 'input_number', 'input_select', 'input_text', 'counter', 'timer'])
        .optional()
        .describe('Tipo de helper a listar (opcional, omitir para todos)'),
    },
    ({ domain }) => ha.listHelpers(domain ?? null)
  );

  tool(server, 'ha_create_helper',
    `Crea un helper en Home Assistant.

Ejemplos por tipo:
- input_boolean:  {"id":"modo_cine","name":"Modo Cine","icon":"mdi:movie"}
- input_number:   {"id":"temp_objetivo","name":"Temp objetivo","min":16,"max":30,"step":0.5,"unit_of_measurement":"°C","mode":"slider"}
- input_select:   {"id":"modo_casa","name":"Modo Casa","options":["Normal","Vacaciones","Cine","Noche"]}
- input_text:     {"id":"mensaje_bienvenida","name":"Mensaje","max":255}
- counter:        {"id":"visitas","name":"Contador visitas","initial":0,"minimum":0,"step":1}
- timer:          {"id":"timer_cocina","name":"Timer cocina","duration":"00:30:00","restore":true}`,
    {
      domain: z.enum(['input_boolean', 'input_number', 'input_select', 'input_text', 'counter', 'timer'])
        .describe('Tipo de helper a crear'),
      config: z.record(z.unknown()).describe('Configuración del helper como objeto JSON (incluir "id" y "name" como mínimo)'),
    },
    ({ domain, config }) => ha.createHelper(domain, config)
  );

  tool(server, 'ha_delete_helper',
    'Elimina un helper de Home Assistant.',
    {
      domain: z.enum(['input_boolean', 'input_number', 'input_select', 'input_text', 'counter', 'timer'])
        .describe('Tipo de helper'),
      helper_id: z.string().describe('ID del helper (sin el prefijo del dominio, ej: "modo_cine" no "input_boolean.modo_cine")'),
    },
    ({ domain, helper_id }) => ha.deleteHelper(domain, helper_id)
  );

  tool(server, 'ha_list_statistic_ids',
    'Lista todas las entidades que tienen estadísticas de largo plazo en el recorder de HA. Usa los IDs devueltos en ha_get_statistics.',
    {},
    () => ha.listStatisticIds()
  );

  tool(server, 'ha_get_statistics',
    `Obtiene estadísticas agregadas (min, max, mean, sum) de una o más entidades para un período de tiempo.
Ideal para analizar consumo energético, temperaturas, etc. a lo largo de días, semanas o meses.

Ejemplo: temperatura de los últimos 7 días agrupada por día:
- statistic_ids: ["sensor.temperatura_salon"]
- start_time: "2024-11-01T00:00:00+00:00"
- period: "day"`,
    {
      statistic_ids: z.array(z.string()).describe('Lista de entity_ids con estadísticas (usar ha_list_statistic_ids para ver disponibles)'),
      start_time: z.string().describe('Fecha de inicio en formato ISO 8601, ej: "2024-11-01T00:00:00+00:00"'),
      period: z.enum(['5minute', 'hour', 'day', 'week', 'month']).default('day').describe('Granularidad de la agrupación (default: day)'),
      end_time: z.string().optional().describe('Fecha de fin en ISO 8601 (opcional, default: ahora)'),
    },
    ({ statistic_ids, start_time, period, end_time }) =>
      ha.getStatistics(statistic_ids, start_time, period ?? 'day', end_time ?? null)
  );

  tool(server, 'ha_get_services',
    `Lista todos los servicios disponibles en Home Assistant con sus esquemas de parámetros.
Es la herramienta más importante para descubrir qué servicios puedes llamar con ha_call_service.
Filtra por dominio para obtener solo los servicios de luz, clima, media player, etc.`,
    {
      domain: z.string().optional().describe('Filtrar por dominio: light, climate, media_player, etc. (opcional, omitir para todos)'),
    },
    ({ domain }) => ha.getServices(domain ?? null)
  );

  tool(server, 'ha_create_scene',
    `Crea una nueva escena en Home Assistant (modo storage).
Una escena captura el estado de múltiples entidades y las restaura al activarla.

Ejemplo:
{
  "name": "Cine",
  "entities": {
    "light.sala": {"state": "on", "brightness": 50},
    "media_player.tv": {"state": "on"}
  }
}`,
    {
      config: z.record(z.unknown()).describe('Configuración de la escena con "name" y "entities"'),
    },
    ({ config }) => ha.createScene(config)
  );

  tool(server, 'ha_update_scene',
    'Actualiza una escena existente. Usa ha_get_entities_by_domain con domain="scene" para obtener IDs.',
    {
      scene_id: z.string().describe('ID de la escena (sin el prefijo scene., ej: "cine" para scene.cine)'),
      config: z.record(z.unknown()).describe('Nueva configuración completa de la escena'),
    },
    ({ scene_id, config }) => ha.updateScene(scene_id, config)
  );

  tool(server, 'ha_delete_scene',
    'Elimina permanentemente una escena de Home Assistant.',
    {
      scene_id: z.string().describe('ID de la escena (sin el prefijo scene.)'),
    },
    ({ scene_id }) => ha.deleteScene(scene_id)
  );

  tool(server, 'ha_create_script',
    `Crea o actualiza un script en Home Assistant (modo storage).
Los scripts son secuencias de acciones reutilizables que pueden recibir variables.

Ejemplo:
{
  "alias": "Apagar todo",
  "sequence": [
    {"service": "light.turn_off", "target": {"entity_id": "all"}},
    {"service": "media_player.turn_off", "target": {"entity_id": "all"}}
  ],
  "mode": "single"
}`,
    {
      script_id: z.string().describe('ID del script (snake_case, ej: "apagar_todo"). Se crea si no existe.'),
      config: z.record(z.unknown()).describe('Configuración del script con "alias", "sequence" y "mode"'),
    },
    ({ script_id, config }) => ha.createOrUpdateScript(script_id, config)
  );

  tool(server, 'ha_delete_script',
    'Elimina permanentemente un script de Home Assistant.',
    {
      script_id: z.string().describe('ID del script (sin el prefijo script., ej: "apagar_todo")'),
    },
    ({ script_id }) => ha.deleteScript(script_id)
  );

  tool(server, 'ha_get_core_info',
    'Obtiene información del core de Home Assistant: versión, estado, ubicación, zona horaria y unidades.',
    {},
    () => ha.getCoreInfo()
  );

  tool(server, 'ha_check_config',
    'Valida la configuración YAML de Home Assistant sin aplicar cambios ni reiniciar. Ideal antes de ha_restart.',
    {},
    () => ha.checkConfig()
  );

  tool(server, 'ha_restart',
    'Reinicia Home Assistant core. La conectividad se perderá ~30 segundos. Usa ha_check_config antes para validar. Confirma con el usuario.',
    {},
    () => ha.restart()
  );

  tool(server, 'ha_list_integrations',
    `Lista todas las integraciones instaladas en Home Assistant (config entries).
Devuelve entry_id, domain, título, estado (loaded/setup_error) y si soporta recarga.
Usa el entry_id con ha_reload_integration para recargar sin reiniciar.`,
    {},
    () => ha.listIntegrations()
  );

  tool(server, 'ha_reload_integration',
    'Recarga una integración específica sin reiniciar Home Assistant. No todas las integraciones soportan recarga.',
    {
      entry_id: z.string().describe('ID de la config entry (obtenlo con ha_list_integrations)'),
    },
    ({ entry_id }) => ha.reloadIntegration(entry_id)
  );

  tool(server, 'ha_list_addons',
    `Lista todos los add-ons instalados en Home Assistant con su estado, versión y uso de recursos.
Solo disponible en Home Assistant OS o instalaciones Supervised. Retorna error en otras instalaciones.`,
    {},
    () => ha.listAddons()
  );

  tool(server, 'ha_get_addon_info',
    'Obtiene información detallada de un add-on: estado, versión, red, opciones de configuración.',
    {
      slug: z.string().describe('Slug del add-on, ej: "core_mosquitto", "a0d7b954_vscode"'),
    },
    ({ slug }) => ha.getAddonInfo(slug)
  );

  tool(server, 'ha_start_addon',
    'Inicia un add-on detenido. Solo disponible en HA OS o Supervised.',
    {
      slug: z.string().describe('Slug del add-on (obtenlo con ha_list_addons)'),
    },
    ({ slug }) => ha.startAddon(slug)
  );

  tool(server, 'ha_stop_addon',
    'Detiene un add-on en ejecución. Solo disponible en HA OS o Supervised.',
    {
      slug: z.string().describe('Slug del add-on (obtenlo con ha_list_addons)'),
    },
    ({ slug }) => ha.stopAddon(slug)
  );

  tool(server, 'ha_restart_addon',
    'Reinicia un add-on. Solo disponible en HA OS o Supervised.',
    {
      slug: z.string().describe('Slug del add-on (obtenlo con ha_list_addons)'),
    },
    ({ slug }) => ha.restartAddon(slug)
  );

  tool(server, 'ha_list_calendars',
    'Lista todos los calendarios integrados en Home Assistant (Google Calendar, CalDAV, etc.).',
    {},
    () => ha.listCalendars()
  );

  tool(server, 'ha_get_calendar_events',
    'Obtiene los eventos de un calendario en un rango de fechas.',
    {
      calendar_entity_id: z.string().describe('ID de la entidad calendario, ej: "calendar.personal"'),
      start: z.string().describe('Fecha de inicio en ISO 8601, ej: "2024-12-01T00:00:00.000Z"'),
      end: z.string().describe('Fecha de fin en ISO 8601, ej: "2024-12-31T23:59:59.000Z"'),
    },
    ({ calendar_entity_id, start, end }) => ha.getCalendarEvents(calendar_entity_id, start, end)
  );

  tool(server, 'ha_trigger_webhook',
    `Dispara un webhook de Home Assistant por su ID.
Útil para activar automatizaciones configuradas con el trigger de tipo "webhook".`,
    {
      webhook_id: z.string().describe('ID del webhook configurado en la automatización'),
      data: z.record(z.unknown()).optional().describe('Datos opcionales a pasar al webhook'),
    },
    ({ webhook_id, data }) => ha.triggerWebhook(webhook_id, data ?? {})
  );

  tool(server, 'ha_list_backups',
    'Lista todos los backups disponibles en Home Assistant con nombre, fecha, tamaño y tipo.',
    {},
    () => ha.listBackups()
  );

  tool(server, 'ha_create_backup',
    'Crea un backup completo de Home Assistant. La operación es asíncrona y puede tardar varios minutos.',
    {
      name: z.string().optional().describe('Nombre descriptivo del backup (opcional)'),
    },
    ({ name }) => ha.createBackup(name ?? null)
  );

  tool(server, 'ha_create_partial_backup',
    `Crea un backup parcial seleccionando exactamente qué incluir.
Más rápido que un backup completo cuando solo necesitas guardar partes específicas.
Nota: en instalaciones Container no hay add-ons — solo configuración y carpetas.

Carpetas válidas: "ssl", "share", "media"

Ejemplo:
{
  "name": "backup-config",
  "include_homeassistant": true,
  "include_folders": ["ssl"]
}`,
    {
      name: z.string().optional().describe('Nombre descriptivo del backup'),
      include_homeassistant: z.boolean().default(true).describe('Incluir configuración de Home Assistant (default: true)'),
      include_folders: z.array(z.string()).optional().describe('Carpetas a incluir: "ssl", "share", "media"'),
    },
    ({ name, include_homeassistant, include_folders }) =>
      ha.createPartialBackup({
        name,
        include_homeassistant: include_homeassistant ?? true,
        include_folders: include_folders ?? [],
      })
  );

  tool(server, 'ha_restore_backup',
    `Restaura un backup completo de Home Assistant por su slug.
Usa ha_list_backups para obtener el slug del backup que quieres restaurar.
ADVERTENCIA: Esta operación reinicia Home Assistant. La conectividad se perderá varios minutos. Confirma con el usuario.`,
    {
      slug: z.string().describe('Slug del backup a restaurar (obtenlo con ha_list_backups)'),
      password: z.string().optional().describe('Contraseña del backup si fue cifrado'),
    },
    ({ slug, password }) => ha.restoreBackup(slug, password ?? null)
  );

  tool(server, 'ha_get_error_log',
    `Obtiene el log de errores de Home Assistant (texto plano).
Útil para diagnosticar problemas con integraciones, entidades o el sistema.
El log contiene entradas de nivel WARNING y ERROR del proceso de HA.`,
    {},
    () => ha.getErrorLog()
  );

  tool(server, 'ha_purge_history',
    `Purga el historial antiguo del recorder de Home Assistant para liberar espacio en la base de datos.
Mantiene los últimos N días de historial y elimina el resto.
repack=true compacta la base de datos SQLite (tarda más pero libera más espacio).`,
    {
      keep_days: z.number().int().positive().default(30).describe('Días de historial a conservar (default: 30)'),
      repack: z.boolean().default(false).describe('Compactar la base de datos después de purgar (default: false)'),
    },
    ({ keep_days, repack }) => ha.purgeHistory(keep_days ?? 30, repack ?? false)
  );

  tool(server, 'ha_list_floors',
    'Lista los pisos/plantas configurados en Home Assistant (requiere HA 2023.9+).',
    {},
    () => ha.listFloors()
  );

  tool(server, 'ha_list_labels',
    'Lista las etiquetas configuradas en Home Assistant para organizar entidades y dispositivos (requiere HA 2024.4+).',
    {},
    () => ha.listLabels()
  );

  tool(server, 'ha_create_label',
    'Crea una etiqueta (label). A diferencia de las categorías, las labels no tienen scope — se pueden asignar a cualquier entidad, área o dispositivo.',
    {
      name: z.string().describe('Nombre de la etiqueta'),
      color: z.string().optional().describe('Color, ej: "blue", "red", "green" (opcional)'),
      description: z.string().optional().describe('Descripción (opcional)'),
      icon: z.string().optional().describe('Icono MDI (opcional)'),
    },
    ({ name, color, description, icon }) => ha.createLabel(name, { color, description, icon })
  );

  tool(server, 'ha_update_label',
    'Actualiza nombre/color/descripción/icono de una etiqueta existente.',
    {
      label_id: z.string().describe('ID de la etiqueta (obtenlo con ha_list_labels)'),
      name: z.string().optional().describe('Nuevo nombre (opcional)'),
      color: z.string().optional().describe('Nuevo color (opcional)'),
      description: z.string().optional().describe('Nueva descripción (opcional)'),
      icon: z.string().optional().describe('Nuevo icono MDI (opcional)'),
    },
    ({ label_id, name, color, description, icon }) => ha.updateLabel(label_id, { name, color, description, icon })
  );

  tool(server, 'ha_delete_label',
    'Elimina una etiqueta. Se desasigna automáticamente de todo lo que la tuviera.',
    {
      label_id: z.string().describe('ID de la etiqueta a eliminar'),
    },
    ({ label_id }) => ha.deleteLabel(label_id)
  );

  tool(server, 'ha_handle_intent',
    `Envía un intent de lenguaje natural a Home Assistant para ejecutar acciones.
Los intents permiten interactuar con HA de forma conversacional.

Intents built-in comunes:
- HassTurnOn / HassTurnOff: { "name": "sala" }
- HassLightSet: { "name": "cocina", "brightness": 50 }
- HassClimateSetTemperature: { "name": "habitacion", "temperature": 22 }`,
    {
      name: z.string().describe('Nombre del intent, ej: "HassTurnOn", "HassTurnOff", "HassLightSet"'),
      slots: z.record(z.unknown()).optional().describe('Parámetros del intent (slots), ej: {"name": "sala", "brightness": 80}'),
    },
    ({ name, slots }) => ha.handleIntent(name, slots ?? {})
  );

  tool(server, 'ha_search_related',
    `Encuentra todo lo que referencia a un item de Home Assistant. Imprescindible antes de
borrar o renombrar algo para saber qué se va a romper (automatizaciones, escenas, dashboards, etc.).`,
    {
      item_type: z.enum(['area', 'automation', 'config_entry', 'device', 'entity', 'group', 'scene', 'script', 'person'])
        .describe('Tipo del item a buscar'),
      item_id: z.string().describe('ID del item (entity_id, area_id, unique_id de automatización, etc.)'),
    },
    ({ item_type, item_id }) => ha.searchRelated(item_type, item_id)
  );

  tool(server, 'ha_list_traces',
    'Lista las ejecuciones (traces) registradas de una automatización o script — punto de partida para depurar por qué (no) se disparó.',
    {
      domain: z.enum(['automation', 'script']).describe('Dominio a inspeccionar'),
      item_id: z.string().optional().describe('Filtrar por un unique_id específico (opcional, omitir para todas)'),
    },
    ({ domain, item_id }) => ha.listTraces(domain, item_id ?? null)
  );

  tool(server, 'ha_get_trace',
    'Obtiene la traza detallada paso a paso (triggers, conditions, actions evaluados) de una ejecución específica. Usa ha_list_traces para obtener el run_id.',
    {
      domain: z.enum(['automation', 'script']).describe('Dominio'),
      item_id: z.string().describe('unique_id de la automatización o script'),
      run_id: z.string().describe('ID de la ejecución (obtenlo con ha_list_traces)'),
    },
    ({ domain, item_id, run_id }) => ha.getTrace(domain, item_id, run_id)
  );

  tool(server, 'ha_get_trace_contexts',
    'Lista los context_id con traza asociada, útil para seguir cadenas de automatizaciones que se disparan entre sí.',
    {
      domain: z.enum(['automation', 'script']).optional().describe('Filtrar por dominio (opcional)'),
      item_id: z.string().optional().describe('Filtrar por unique_id (opcional, requiere domain)'),
    },
    ({ domain, item_id }) => ha.getTraceContexts(domain ?? null, item_id ?? null)
  );

  tool(server, 'ha_list_todo_items',
    'Lista los ítems de una lista de tareas/compras de Home Assistant (entidad todo.*).',
    {
      entity_id: z.string().describe('ID de la entidad todo, ej: "todo.lista_compras"'),
    },
    ({ entity_id }) => ha.listTodoItems(entity_id)
  );

  tool(server, 'ha_move_todo_item',
    'Reordena un ítem dentro de una lista de tareas. Para agregar/completar/eliminar ítems usa ha_call_service con domain="todo".',
    {
      entity_id: z.string().describe('ID de la entidad todo'),
      uid: z.string().describe('UID del ítem a mover (obtenlo con ha_list_todo_items)'),
      previous_uid: z.string().optional().describe('UID del ítem después del cual colocarlo. Omitir para moverlo al principio.'),
    },
    ({ entity_id, uid, previous_uid }) => ha.moveTodoItem(entity_id, uid, previous_uid ?? null)
  );

  tool(server, 'ha_get_logbook_events',
    `Consulta el logbook con filtros avanzados (entidad, dispositivo o context_id) vía WebSocket.
Más flexible que ha_get_logbook, que solo filtra por periodo y una entidad.`,
    {
      start_time: z.string().describe('Fecha de inicio en ISO 8601'),
      end_time: z.string().optional().describe('Fecha de fin en ISO 8601 (opcional, default: ahora)'),
      entity_ids: z.array(z.string()).optional().describe('Filtrar por entidades específicas'),
      device_ids: z.array(z.string()).optional().describe('Filtrar por dispositivos específicos'),
      context_id: z.string().optional().describe('Filtrar por un context_id específico (para seguir una cadena de eventos)'),
    },
    ({ start_time, end_time, entity_ids, device_ids, context_id }) =>
      ha.getLogbookEventsFiltered({ startTime: start_time, endTime: end_time, entityIds: entity_ids, deviceIds: device_ids, contextId: context_id })
  );

  tool(server, 'ha_validate_statistics',
    'Detecta inconsistencias en las estadísticas de largo plazo del recorder. Corre esto antes de confiar en el dashboard de Energía.',
    {},
    () => ha.validateStatistics()
  );

  tool(server, 'ha_get_statistics_metadata',
    'Obtiene metadata (unidad, nombre, fuente) de estadísticas de largo plazo. Omitir statistic_ids para todas.',
    {
      statistic_ids: z.array(z.string()).optional().describe('IDs de estadísticas a consultar (opcional)'),
    },
    ({ statistic_ids }) => ha.getStatisticsMetadata(statistic_ids ?? null)
  );

  tool(server, 'ha_adjust_sum_statistics',
    `Corrige una estadística acumulada (sum) sumando un ajuste en un punto del tiempo.
Útil cuando un medidor de energía/agua se reinició y las lecturas quedaron descuadradas.`,
    {
      statistic_id: z.string().describe('ID de la estadística a ajustar'),
      start_time: z.string().describe('Momento del ajuste en ISO 8601 (debe coincidir con un punto existente)'),
      adjustment: z.number().describe('Cantidad a sumar (puede ser negativa)'),
      adjustment_unit_of_measurement: z.string().nullable().optional().describe('Unidad del ajuste, ej: "kWh". null si coincide con la unidad normalizada.'),
    },
    ({ statistic_id, start_time, adjustment, adjustment_unit_of_measurement }) =>
      ha.adjustSumStatistics(statistic_id, start_time, adjustment, adjustment_unit_of_measurement ?? null)
  );

  tool(server, 'ha_browse_media',
    'Explora el árbol de fuentes de media disponibles (medios locales, TTS, etc.). Omitir media_content_id para ver la raíz.',
    {
      media_content_id: z.string().default('').describe('ID del contenido a explorar (opcional, default: raíz)'),
    },
    ({ media_content_id }) => ha.browseMedia(media_content_id ?? '')
  );

  tool(server, 'ha_search_media',
    'Busca contenido reproducible dentro de una fuente de media.',
    {
      search_query: z.string().describe('Texto a buscar'),
      media_content_id: z.string().default('').describe('Punto de partida de la búsqueda (opcional, default: raíz)'),
      media_filter_classes: z.array(z.string()).optional().describe('Filtrar por clase de media, ej: ["music", "movie"]'),
    },
    ({ search_query, media_content_id, media_filter_classes }) =>
      ha.searchMedia(search_query, media_content_id ?? '', media_filter_classes ?? null)
  );

  tool(server, 'ha_resolve_media',
    'Resuelve un media_content_id a una URL reproducible, para usar con ha_control_media_player (play_media).',
    {
      media_content_id: z.string().describe('ID del contenido a resolver (obtenlo con ha_browse_media o ha_search_media)'),
      expires: z.number().int().positive().optional().describe('Segundos de validez de la URL (opcional)'),
    },
    ({ media_content_id, expires }) => ha.resolveMedia(media_content_id, expires ?? null)
  );

  tool(server, 'ha_get_energy_info',
    'Metadata de las fuentes de energía configuradas (grid, solar, gas, agua, dispositivos monitoreados).',
    {},
    () => ha.getEnergyInfo()
  );

  tool(server, 'ha_get_energy_preferences',
    'Preferencias completas del dashboard de Energía: fuentes configuradas y su configuración detallada.',
    {},
    () => ha.getEnergyPreferences()
  );

  tool(server, 'ha_validate_energy_preferences',
    'Valida la configuración del dashboard de Energía y reporta problemas (sensores faltantes, unidades incorrectas, etc.).',
    {},
    () => ha.validateEnergyPreferences()
  );

  tool(server, 'ha_get_solar_forecast',
    'Pronóstico de producción solar del día, si hay una integración de forecast solar configurada.',
    {},
    () => ha.getSolarForecast()
  );

  tool(server, 'ha_list_categories',
    'Lista las categorías configuradas dentro de un scope (ej: "automation", "script") para organizar entidades sin usar áreas.',
    {
      scope: z.string().describe('Scope de las categorías, ej: "automation", "script", "entity"'),
    },
    ({ scope }) => ha.listCategories(scope)
  );

  tool(server, 'ha_create_category',
    'Crea una categoría dentro de un scope.',
    {
      scope: z.string().describe('Scope de la categoría, ej: "automation"'),
      name: z.string().describe('Nombre de la categoría'),
      icon: z.string().nullable().optional().describe('Icono MDI (opcional)'),
    },
    ({ scope, name, icon }) => ha.createCategory(scope, name, icon ?? null)
  );

  tool(server, 'ha_update_category',
    'Actualiza el nombre/icono de una categoría existente.',
    {
      scope: z.string().describe('Scope de la categoría'),
      category_id: z.string().describe('ID de la categoría (obtenlo con ha_list_categories)'),
      name: z.string().optional().describe('Nuevo nombre (opcional)'),
      icon: z.string().nullable().optional().describe('Nuevo icono MDI (opcional)'),
    },
    ({ scope, category_id, name, icon }) => ha.updateCategory(scope, category_id, { name, icon })
  );

  tool(server, 'ha_delete_category',
    'Elimina una categoría de un scope.',
    {
      scope: z.string().describe('Scope de la categoría'),
      category_id: z.string().describe('ID de la categoría a eliminar'),
    },
    ({ scope, category_id }) => ha.deleteCategory(scope, category_id)
  );

  tool(server, 'ha_list_repair_issues',
    'Lista los problemas/avisos activos detectados por Home Assistant: configuración deprecada, integraciones fallando, etc. Chequeo de salud proactivo.',
    {},
    () => ha.listRepairIssues()
  );

  tool(server, 'ha_get_repair_issue_data',
    'Obtiene el detalle de un problema específico detectado por Home Assistant (placeholders para su flujo de reparación).',
    {
      domain: z.string().describe('Dominio de la integración que reportó el problema'),
      issue_id: z.string().describe('ID del problema (obtenlo con ha_list_repair_issues)'),
    },
    ({ domain, issue_id }) => ha.getRepairIssueData(domain, issue_id)
  );

  tool(server, 'ha_get_config_entries',
    'Devuelve config entries filtradas por tipo y/o dominio — más preciso que ha_list_integrations cuando hay muchas integraciones.',
    {
      type_filter: z.array(z.string()).optional().describe('Filtrar por tipo, ej: ["integration"] (opcional)'),
      domain: z.string().optional().describe('Filtrar por dominio, ej: "mqtt" (opcional)'),
    },
    ({ type_filter, domain }) => ha.getConfigEntries(type_filter ?? null, domain ?? null)
  );

  tool(server, 'ha_list_available_integrations',
    'Lista los handlers de integración instalables en Home Assistant — el primer paso para agregar una integración nueva (no solo recargar una existente).',
    {
      type_filter: z.string().optional().describe('Filtrar por tipo de integración (opcional)'),
    },
    ({ type_filter }) => ha.listAvailableIntegrations(type_filter ?? null)
  );

  tool(server, 'ha_start_config_flow',
    `Inicia el flujo de configuración de una integración nueva (o de reconfiguración si se pasa entry_id).
Devuelve el primer paso (formulario/schema) — continúalo con ha_advance_config_flow.`,
    {
      handler: z.string().describe('Nombre del dominio/integración a configurar, ej: "mqtt" (obtenlo con ha_list_available_integrations)'),
      entry_id: z.string().optional().describe('ID de una config entry existente, para reconfigurarla en vez de crear una nueva'),
    },
    ({ handler, entry_id }) => ha.startConfigFlow(handler, entry_id ?? null)
  );

  tool(server, 'ha_get_config_flow_step',
    'Obtiene el paso actual (formulario/schema pendiente) de un flujo de configuración en curso.',
    {
      flow_id: z.string().describe('ID del flujo (obtenlo de ha_start_config_flow o ha_advance_config_flow)'),
    },
    ({ flow_id }) => ha.getConfigFlowStep(flow_id)
  );

  tool(server, 'ha_advance_config_flow',
    'Envía los datos de un paso del flujo de configuración (los campos que pida el schema del paso actual) y avanza al siguiente.',
    {
      flow_id: z.string().describe('ID del flujo en curso'),
      user_input: z.record(z.unknown()).describe('Datos del paso actual, según el schema devuelto por el paso anterior'),
    },
    ({ flow_id, user_input }) => ha.advanceConfigFlow(flow_id, user_input)
  );

  tool(server, 'ha_get_network_adapters',
    'Lista los adaptadores de red configurados en Home Assistant y su estado (habilitado, IPv4/IPv6, auto-config).',
    {},
    () => ha.getNetworkAdapters()
  );

  tool(server, 'ha_get_network_urls',
    'URLs internas/externas/de Nabu Casa configuradas para acceder a esta instancia de Home Assistant.',
    {},
    () => ha.getNetworkUrls()
  );

  tool(server, 'ha_process_conversation',
    `Envía texto libre en lenguaje natural al motor de conversación de Home Assistant.
Más flexible que ha_handle_intent (que requiere un intent estructurado) — soporta frases completas.`,
    {
      text: z.string().describe('Texto en lenguaje natural, ej: "enciende la luz de la sala"'),
      conversation_id: z.string().optional().describe('ID de conversación para mantener contexto entre turnos (opcional)'),
      language: z.string().optional().describe('Código de idioma, ej: "es" (opcional)'),
      agent_id: z.string().optional().describe('ID del agente de conversación a usar (opcional, obtenlo con ha_list_conversation_agents)'),
      device_id: z.string().optional().describe('ID del dispositivo origen (opcional)'),
    },
    ({ text, conversation_id, language, agent_id, device_id }) =>
      ha.processConversation(text, { conversationId: conversation_id, language, agentId: agent_id, deviceId: device_id })
  );

  tool(server, 'ha_list_conversation_agents',
    'Lista los agentes de conversación disponibles en Home Assistant, opcionalmente filtrados por idioma/país.',
    {
      language: z.string().optional().describe('Código de idioma (opcional)'),
      country: z.string().optional().describe('Código de país (opcional)'),
    },
    ({ language, country }) => ha.listConversationAgents(language ?? null, country ?? null)
  );

  tool(server, 'ha_list_assist_languages',
    'Lista los idiomas soportados por el pipeline de Assist (asistente de voz/conversación) de Home Assistant.',
    {},
    () => ha.listAssistLanguages()
  );

  tool(server, 'ha_check_backup_download',
    `Verifica que un backup existe y es descargable, devolviendo su tamaño y tipo de contenido.
No transfiere el archivo binario — para descargarlo usa directamente
\${HA_URL}/api/backup/download/{backup_id}?agent_id=... con el token como header Authorization: Bearer.`,
    {
      backup_id: z.string().describe('Slug del backup (obtenlo con ha_list_backups)'),
      agent_id: z.string().default('backup.local').describe('Agente de backup (default: "backup.local")'),
      password: z.string().optional().describe('Contraseña del backup si fue cifrado'),
    },
    ({ backup_id, agent_id, password }) => ha.checkBackupDownload(backup_id, agent_id ?? 'backup.local', password ?? null)
  );

  tool(server, 'ha_upload_backup',
    'Sube un archivo de backup (.tar) codificado en base64 y lo registra en Home Assistant.',
    {
      base64_content: z.string().describe('Contenido del archivo .tar codificado en base64'),
      filename: z.string().describe('Nombre del archivo, ej: "backup.tar"'),
      agent_ids: z.array(z.string()).default(['backup.local']).describe('Agentes de backup donde registrarlo (default: ["backup.local"])'),
    },
    ({ base64_content, filename, agent_ids }) => ha.uploadBackupFile(base64_content, filename, agent_ids ?? ['backup.local'])
  );

  // ── PostgreSQL tools ─────────────────────────────────────────────────────────

  tool(server, 'pg_connect',
    `Registra una conexión PostgreSQL con un nombre para usarla en el resto de tools.
Las credenciales se guardan solo en memoria y se pierden al reiniciar el server.
Formato de URL: postgresql://usuario:contraseña@host:5432/base_de_datos`,
    {
      name: z.string().describe('Nombre para identificar esta conexión, ej: "produccion", "local"'),
      connection_string: z.string().describe('URL de conexión PostgreSQL completa'),
    },
    ({ name, connection_string }) => pg.connect(name, connection_string)
  );

  tool(server, 'pg_disconnect',
    'Cierra una conexión PostgreSQL registrada y libera sus recursos.',
    {
      name: z.string().describe('Nombre de la conexión a cerrar'),
    },
    ({ name }) => pg.disconnect(name)
  );

  tool(server, 'pg_list_connections',
    'Lista las conexiones PostgreSQL activas (muestra la URL sin la contraseña).',
    {},
    () => pg.listConnections()
  );

  tool(server, 'pg_list_databases',
    'Lista todas las bases de datos del servidor con su tamaño.',
    {
      connection: z.string().describe('Nombre de la conexión registrada con pg_connect'),
    },
    ({ connection }) => pg.listDatabases(connection)
  );

  tool(server, 'pg_list_schemas',
    'Lista los schemas de la base de datos actual.',
    {
      connection: z.string().describe('Nombre de la conexión'),
    },
    ({ connection }) => pg.listSchemas(connection)
  );

  tool(server, 'pg_list_tables',
    'Lista las tablas de un schema con su tamaño y número estimado de filas.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      schema: z.string().default('public').describe('Schema a explorar (default: public)'),
    },
    ({ connection, schema }) => pg.listTables(connection, schema ?? 'public')
  );

  tool(server, 'pg_describe_table',
    'Describe una tabla: columnas, tipos, constraints, claves primarias y foráneas.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      table: z.string().describe('Nombre de la tabla'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    ({ connection, table, schema }) => pg.describeTable(connection, table, schema ?? 'public')
  );

  tool(server, 'pg_list_indexes',
    'Lista los índices de una tabla con su tipo y tamaño.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      table: z.string().describe('Nombre de la tabla'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    ({ connection, table, schema }) => pg.listIndexes(connection, table, schema ?? 'public')
  );

  tool(server, 'pg_list_views',
    'Lista las vistas de un schema.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    ({ connection, schema }) => pg.listViews(connection, schema ?? 'public')
  );

  tool(server, 'pg_list_functions',
    'Lista las funciones y procedimientos almacenados de un schema.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    ({ connection, schema }) => pg.listFunctions(connection, schema ?? 'public')
  );

  tool(server, 'pg_list_users',
    'Lista todos los roles y usuarios del servidor PostgreSQL.',
    {
      connection: z.string().describe('Nombre de la conexión'),
    },
    ({ connection }) => pg.listUsers(connection)
  );

  tool(server, 'pg_query',
    'Ejecuta una consulta SELECT y devuelve los resultados (máximo 100 filas por default).',
    {
      connection: z.string().describe('Nombre de la conexión'),
      sql: z.string().describe('Query SQL a ejecutar'),
      limit: z.number().int().positive().default(100).describe('Máximo de filas a retornar'),
    },
    ({ connection, sql, limit }) => pg.runQuery(connection, sql, limit ?? 100)
  );

  tool(server, 'pg_execute',
    'Ejecuta un statement SQL (INSERT, UPDATE, DELETE, ALTER, etc.) y retorna el resultado.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      sql: z.string().describe('Statement SQL a ejecutar'),
    },
    ({ connection, sql }) => pg.execute(connection, sql)
  );

  tool(server, 'pg_explain',
    'Ejecuta EXPLAIN ANALYZE en una query para ver el plan de ejecución y tiempos reales.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      sql: z.string().describe('Query SQL a analizar'),
    },
    ({ connection, sql }) => pg.explain(connection, sql)
  );

  tool(server, 'pg_create_database',
    'Crea una nueva base de datos.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      db_name: z.string().describe('Nombre de la nueva base de datos'),
      owner: z.string().optional().describe('Propietario (opcional)'),
    },
    ({ connection, db_name, owner }) => pg.createDatabase(connection, db_name, owner)
  );

  tool(server, 'pg_create_schema',
    'Crea un nuevo schema en la base de datos actual.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      schema_name: z.string().describe('Nombre del schema'),
      owner: z.string().optional().describe('Propietario (opcional)'),
    },
    ({ connection, schema_name, owner }) => pg.createSchema(connection, schema_name, owner)
  );

  tool(server, 'pg_create_table',
    `Crea una tabla con las columnas especificadas.
Ejemplo de columnas:
[
  {"name": "id", "type": "SERIAL", "primary_key": true},
  {"name": "email", "type": "VARCHAR(255)", "nullable": false, "unique": true},
  {"name": "created_at", "type": "TIMESTAMPTZ", "nullable": false, "default": "NOW()"}
]`,
    {
      connection: z.string().describe('Nombre de la conexión'),
      table: z.string().describe('Nombre de la tabla'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      columns: z.array(z.object({
        name: z.string(),
        type: z.string(),
        nullable: z.boolean().optional(),
        primary_key: z.boolean().optional(),
        unique: z.boolean().optional(),
        default: z.string().optional(),
      })).describe('Definición de columnas'),
    },
    ({ connection, table, schema, columns }) => pg.createTable(connection, table, columns, schema ?? 'public')
  );

  tool(server, 'pg_drop_table',
    'Elimina una tabla. Usar cascade=true para eliminar también objetos dependientes.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      table: z.string().describe('Nombre de la tabla'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      cascade: z.boolean().default(false).describe('true para CASCADE, false para RESTRICT'),
    },
    ({ connection, table, schema, cascade }) => pg.dropTable(connection, table, schema ?? 'public', cascade ?? false)
  );

  tool(server, 'pg_running_queries',
    'Muestra las queries en ejecución actualmente con su duración y estado.',
    {
      connection: z.string().describe('Nombre de la conexión'),
    },
    ({ connection }) => pg.runningQueries(connection)
  );

  tool(server, 'pg_kill_query',
    'Termina un proceso/query de PostgreSQL por su PID.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      pid: z.number().int().describe('PID del proceso a terminar (obtenlo con pg_running_queries)'),
    },
    ({ connection, pid }) => pg.killQuery(connection, pid)
  );

  tool(server, 'pg_table_stats',
    'Estadísticas de tablas: filas vivas/muertas, último vacuum/analyze, tamaño.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    ({ connection, schema }) => pg.tableStats(connection, schema ?? 'public')
  );

  tool(server, 'pg_health_check',
    'Resumen de salud del servidor: conexiones activas, cache hit ratio, tablas con bloat.',
    {
      connection: z.string().describe('Nombre de la conexión'),
    },
    ({ connection }) => pg.healthCheck(connection)
  );

  tool(server, 'pg_er_diagram',
    'Genera un diagrama ER en texto con las tablas y relaciones (foreign keys) de un schema.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    ({ connection, schema }) => pg.erDiagram(connection, schema ?? 'public')
  );

  tool(server, 'pg_dump_schema',
    'Genera el DDL completo (CREATE TABLE, CREATE VIEW, etc.) de un schema como texto SQL.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      schema: z.string().default('public').describe('Schema a exportar (default: public)'),
    },
    ({ connection, schema }) => pg.dumpSchema(connection, schema ?? 'public')
  );

  tool(server, 'pg_suggest_indexes',
    'Analiza el uso de tablas e identifica: tablas sin índices con muchos seq scans e índices existentes sin uso.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      schema: z.string().default('public').describe('Schema a analizar (default: public)'),
    },
    ({ connection, schema }) => pg.suggestIndexes(connection, schema ?? 'public')
  );

  // ── Docker tools ─────────────────────────────────────────────────────────────

  const conn = z.string().default('local').describe('Nombre de la conexión (default: "local"). Usa docker_connect para agregar servidores remotos.');

  tool(server, 'docker_connect',
    `Conecta a un servidor Docker remoto y lo registra con un nombre.
La conexión queda disponible para el resto de tools usando ese nombre.

Conexión SSH (recomendada — no requiere configuración en el servidor):
  Solo necesita SSH activo y Docker instalado.
  Autenticación por clave privada (pasar contenido del archivo, ej: ~/.ssh/id_rsa) o contraseña.

Conexión HTTP/HTTPS (alternativa — requiere exponer la API REST):
  Editar /lib/systemd/system/docker.service, agregar a ExecStart:
  -H tcp://0.0.0.0:2375 -H unix:///var/run/docker.sock
  Luego: systemctl daemon-reload && systemctl restart docker`,
    {
      name: z.string().describe('Nombre para identificar este servidor, ej: "lab1", "pi4", "nas"'),
      host: z.string().describe('IP o hostname del servidor Docker, ej: "192.168.1.100"'),
      protocol: z.enum(['ssh', 'http', 'https']).default('ssh').describe('Protocolo: ssh (default, recomendado), http o https'),
      port: z.number().int().optional().describe('Puerto (default: 22 para SSH, 2375 para HTTP/HTTPS)'),
      username: z.string().default('root').describe('Usuario SSH (solo protocolo ssh, default: "root")'),
      private_key: z.string().optional().describe('Contenido de la clave privada SSH, ej: contenido de ~/.ssh/id_rsa'),
      password: z.string().optional().describe('Contraseña SSH (alternativa a private_key)'),
    },
    ({ name, host, protocol, port, username, private_key, password }) =>
      docker.connect(name, host, { port, protocol: protocol ?? 'ssh', username: username ?? 'root', privateKey: private_key, password })
  );

  tool(server, 'docker_disconnect',
    'Desregistra una conexión Docker remota. La conexión "local" no puede eliminarse.',
    {
      name: z.string().describe('Nombre de la conexión a eliminar'),
    },
    ({ name }) => docker.disconnect(name)
  );

  tool(server, 'docker_list_connections',
    'Lista todas las conexiones Docker registradas (local + remotas).',
    {},
    () => docker.listConnections()
  );

  tool(server, 'docker_system_info',
    'Muestra información del daemon Docker: versión, OS, CPUs, memoria, contenedores e imágenes.',
    { connection: conn },
    ({ connection }) => docker.systemInfo(connection ?? 'local')
  );

  tool(server, 'docker_list_images',
    'Lista las imágenes Docker con sus tags, tamaño y fecha de creación.',
    { connection: conn },
    ({ connection }) => docker.listImages(connection ?? 'local')
  );

  tool(server, 'docker_pull_image',
    'Descarga una imagen desde el registry. Ej: nginx:latest, postgres:16-alpine.',
    {
      image: z.string().describe('Imagen a descargar, ej: "nginx:latest"'),
      connection: conn,
    },
    ({ image, connection }) => docker.pullImage(image, connection ?? 'local')
  );

  tool(server, 'docker_remove_image',
    'Elimina una imagen Docker por su ID o tag.',
    {
      image_id: z.string().describe('ID o tag de la imagen'),
      force: z.boolean().default(false).describe('true para forzar aunque haya contenedores usando la imagen'),
      connection: conn,
    },
    ({ image_id, force, connection }) => docker.removeImage(image_id, force ?? false, connection ?? 'local')
  );

  tool(server, 'docker_purge_images',
    `Limpia imágenes históricas para liberar espacio en disco.
- dangling: elimina solo imágenes sin tag (<none>:<none>) — capas huérfanas de builds
- unused: elimina todas las imágenes no usadas por ningún contenedor activo (más agresivo)`,
    {
      mode: z.enum(['dangling', 'unused']).default('dangling').describe('dangling = capas huérfanas | unused = todas las no usadas'),
      connection: conn,
    },
    ({ mode, connection }) => docker.purgeImages(mode ?? 'dangling', connection ?? 'local')
  );

  tool(server, 'docker_list_containers',
    'Lista todos los contenedores (corriendo y detenidos) con estado, imagen y puertos.',
    {
      all: z.boolean().default(true).describe('true para incluir detenidos (default: true)'),
      connection: conn,
    },
    ({ all, connection }) => docker.listContainers(all ?? true, connection ?? 'local')
  );

  tool(server, 'docker_inspect_container',
    'Muestra información detallada de un contenedor: env vars, puertos, volúmenes, red, restart policy.',
    {
      name_or_id: z.string().describe('Nombre o ID del contenedor'),
      connection: conn,
    },
    ({ name_or_id, connection }) => docker.inspectContainer(name_or_id, connection ?? 'local')
  );

  tool(server, 'docker_start_container',
    'Inicia un contenedor detenido.',
    {
      name_or_id: z.string().describe('Nombre o ID del contenedor'),
      connection: conn,
    },
    ({ name_or_id, connection }) => docker.startContainer(name_or_id, connection ?? 'local')
  );

  tool(server, 'docker_stop_container',
    'Detiene un contenedor en ejecución.',
    {
      name_or_id: z.string().describe('Nombre o ID del contenedor'),
      timeout: z.number().int().positive().default(10).describe('Segundos antes de SIGKILL (default: 10)'),
      connection: conn,
    },
    ({ name_or_id, timeout, connection }) => docker.stopContainer(name_or_id, timeout ?? 10, connection ?? 'local')
  );

  tool(server, 'docker_restart_container',
    'Reinicia un contenedor.',
    {
      name_or_id: z.string().describe('Nombre o ID del contenedor'),
      timeout: z.number().int().positive().default(10).describe('Segundos antes de SIGKILL (default: 10)'),
      connection: conn,
    },
    ({ name_or_id, timeout, connection }) => docker.restartContainer(name_or_id, timeout ?? 10, connection ?? 'local')
  );

  tool(server, 'docker_remove_container',
    'Elimina un contenedor. force=true para eliminar aunque esté corriendo.',
    {
      name_or_id: z.string().describe('Nombre o ID del contenedor'),
      force: z.boolean().default(false).describe('true para forzar eliminación aunque esté corriendo'),
      connection: conn,
    },
    ({ name_or_id, force, connection }) => docker.removeContainer(name_or_id, force ?? false, connection ?? 'local')
  );

  tool(server, 'docker_container_logs',
    'Obtiene los últimos N logs de un contenedor con timestamps.',
    {
      name_or_id: z.string().describe('Nombre o ID del contenedor'),
      lines: z.number().int().positive().default(100).describe('Líneas a retornar (default: 100)'),
      connection: conn,
    },
    ({ name_or_id, lines, connection }) => docker.containerLogs(name_or_id, lines ?? 100, connection ?? 'local')
  );

  tool(server, 'docker_container_stats',
    'Muestra el uso actual de CPU, memoria y red de un contenedor.',
    {
      name_or_id: z.string().describe('Nombre o ID del contenedor'),
      connection: conn,
    },
    ({ name_or_id, connection }) => docker.containerStats(name_or_id, connection ?? 'local')
  );

  tool(server, 'docker_compose_up',
    `Crea y levanta un stack desde un YAML de docker-compose pasado como string.
Para servidores remotos, registra primero la conexión con docker_connect y usa el parámetro connection.

Ejemplo de compose_yaml:
  services:
    web:
      image: nginx:latest
      ports:
        - "8080:80"
      restart: unless-stopped`,
    {
      project_name: z.string().describe('Nombre del proyecto compose'),
      compose_yaml: z.string().describe('Contenido completo del docker-compose.yml'),
      pull: z.boolean().default(false).describe('Pull de imágenes antes de levantar'),
      build: z.boolean().default(false).describe('Rebuild de imágenes con build context'),
      connection: conn,
    },
    ({ project_name, compose_yaml, pull, build, connection }) =>
      docker.composeUp(project_name, compose_yaml, { pull: pull ?? false, build: build ?? false, connection: connection ?? 'local' })
  );

  tool(server, 'docker_compose_down',
    'Detiene y elimina los contenedores de un stack compose por su nombre de proyecto.',
    {
      project_name: z.string().describe('Nombre del proyecto compose'),
      remove_volumes: z.boolean().default(false).describe('Eliminar también los volúmenes del stack'),
      remove_images: z.boolean().default(false).describe('Eliminar también las imágenes usadas'),
      connection: conn,
    },
    ({ project_name, remove_volumes, remove_images, connection }) =>
      docker.composeDown(project_name, { removeVolumes: remove_volumes ?? false, removeImages: remove_images ?? false, connection: connection ?? 'local' })
  );

  tool(server, 'docker_list_compose_stacks',
    'Lista los stacks de docker compose activos con sus servicios y estado.',
    { connection: conn },
    ({ connection }) => docker.listComposeStacks(connection ?? 'local')
  );

  // ── SSH tools ────────────────────────────────────────────────────────────────

  tool(server, 'ssh_connect',
    `Registra una conexión SSH con un nombre para usarla en el resto de tools.
Las credenciales se guardan solo en memoria y se pierden al reiniciar el server.
Soporta autenticación por contraseña o por clave privada (pasar el contenido de la clave, no la ruta).`,
    {
      name: z.string().describe('Nombre para identificar esta conexión, ej: "pi", "lab1", "nas"'),
      host: z.string().describe('IP o hostname del servidor'),
      port: z.number().int().default(22).describe('Puerto SSH (default: 22)'),
      username: z.string().describe('Usuario SSH'),
      password: z.string().optional().describe('Contraseña (alternativa a clave privada)'),
      private_key: z.string().optional().describe('Contenido de la clave privada SSH (ej: contenido de id_rsa)'),
      passphrase: z.string().optional().describe('Passphrase de la clave privada (si aplica)'),
    },
    ({ name, host, port, username, password, private_key, passphrase }) =>
      ssh.register(name, { host, port: port ?? 22, username, password, privateKey: private_key, passphrase })
  );

  tool(server, 'ssh_disconnect',
    'Elimina una conexión SSH registrada de la memoria.',
    { name: z.string().describe('Nombre de la conexión a eliminar') },
    ({ name }) => ssh.unregister(name)
  );

  tool(server, 'ssh_list_connections',
    'Lista las conexiones SSH registradas (sin mostrar contraseñas).',
    {},
    () => ssh.listConnections()
  );

  tool(server, 'ssh_exec',
    `Ejecuta un comando en el servidor remoto y devuelve stdout, stderr y exit code.
Útil para cualquier operación administrativa: instalar paquetes, ver logs, gestionar servicios, etc.`,
    {
      connection: z.string().describe('Nombre de la conexión registrada con ssh_connect'),
      command: z.string().describe('Comando a ejecutar en el servidor remoto'),
      timeout: z.number().int().positive().default(60000).describe('Timeout en milisegundos (default: 60000 = 1 minuto)'),
    },
    ({ connection, command, timeout }) => ssh.exec(connection, command, { timeout: timeout ?? 60_000 })
  );

  tool(server, 'ssh_upload_file',
    'Sube un archivo local al servidor remoto vía SFTP.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      local_path: z.string().describe('Ruta local del archivo a subir'),
      remote_path: z.string().describe('Ruta destino en el servidor remoto'),
    },
    ({ connection, local_path, remote_path }) => ssh.upload(connection, local_path, remote_path)
  );

  tool(server, 'ssh_download_file',
    'Descarga un archivo del servidor remoto al sistema local vía SFTP.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      remote_path: z.string().describe('Ruta del archivo en el servidor remoto'),
      local_path: z.string().describe('Ruta local donde guardar el archivo'),
    },
    ({ connection, remote_path, local_path }) => ssh.download(connection, remote_path, local_path)
  );

  tool(server, 'ssh_read_file',
    'Lee el contenido de un archivo en el servidor remoto sin necesidad de descargarlo.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      remote_path: z.string().describe('Ruta del archivo a leer en el servidor remoto'),
    },
    ({ connection, remote_path }) => ssh.readRemoteFile(connection, remote_path)
  );

  tool(server, 'ssh_write_file',
    'Escribe/sobreescribe un archivo en el servidor remoto con el contenido dado.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      remote_path: z.string().describe('Ruta del archivo destino en el servidor remoto'),
      content: z.string().describe('Contenido a escribir en el archivo'),
    },
    ({ connection, remote_path, content }) => ssh.writeRemoteFile(connection, remote_path, content)
  );

  tool(server, 'ssh_get_system_info',
    'Obtiene información básica del sistema remoto: OS, CPUs, memoria, disco y uptime.',
    {
      connection: z.string().describe('Nombre de la conexión'),
    },
    ({ connection }) => ssh.getSystemInfo(connection)
  );

  tool(server, 'ssh_list_processes',
    'Lista los procesos en ejecución en el servidor remoto. Opcionalmente filtra por nombre.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      filter: z.string().optional().describe('Filtro de texto para buscar procesos específicos (opcional)'),
    },
    ({ connection, filter }) => ssh.listProcesses(connection, filter ?? '')
  );

  tool(server, 'ssh_tail_log',
    'Lee las últimas N líneas de un archivo de log en el servidor remoto.',
    {
      connection: z.string().describe('Nombre de la conexión'),
      log_path: z.string().describe('Ruta al archivo de log, ej: /var/log/syslog'),
      lines: z.number().int().positive().default(50).describe('Número de líneas a leer (default: 50)'),
    },
    ({ connection, log_path, lines }) => ssh.tailLog(connection, log_path, lines ?? 50)
  );

  tool(server, 'ssh_check_ports',
    'Muestra los puertos TCP en escucha en el servidor remoto (ss o netstat).',
    {
      connection: z.string().describe('Nombre de la conexión'),
    },
    ({ connection }) => ssh.checkPorts(connection)
  );

  // ── ASUS Router tools ─────────────────────────────────────────────────────────

  tool(server, 'router_login',
    `Autentica con el router ASUS y guarda la sesión en memoria.
Si ASUS_ROUTER_URL, ASUS_ROUTER_USER y ASUS_ROUTER_PASS están en .env, no hace falta pasar parámetros.
Necesario antes de usar el resto de herramientas del router.`,
    {
      url: z.string().optional().describe('URL del router, ej: http://192.168.50.1 (opcional si está en .env)'),
      username: z.string().optional().describe('Usuario (default: admin o valor de ASUS_ROUTER_USER)'),
      password: z.string().optional().describe('Contraseña del router'),
    },
    ({ url, username, password }) => router.login(url, username, password)
  );

  tool(server, 'router_get_info',
    'Obtiene información general del router: modelo, firmware, IP LAN, WAN, DNS, timezone.',
    {},
    () => router.getRouterInfo()
  );

  tool(server, 'router_get_wan_status',
    'Muestra el estado de la conexión WAN: IP pública, gateway, DNS, tipo de conexión.',
    {},
    () => router.getWanStatus()
  );

  tool(server, 'router_get_health_summary',
    'Resumen completo del estado del router: info general, WAN, WiFi, mesh y firewall.',
    {},
    () => router.getHealthSummary()
  );

  tool(server, 'router_get_wifi_settings',
    'Obtiene la configuración WiFi de todas las bandas (2.4 GHz, 5 GHz, 6 GHz): SSID, canal, radio encendido, smart connect.',
    {},
    () => router.getWifiSettings()
  );

  tool(server, 'router_set_wifi_ssid',
    'Cambia el nombre de red (SSID) de una banda WiFi.',
    {
      band: z.enum(['2.4', '5', '6']).describe('Banda WiFi: "2.4", "5" o "6"'),
      ssid: z.string().min(1).max(32).describe('Nuevo SSID (nombre de red)'),
    },
    ({ band, ssid }) => router.setWifiSsid(band, ssid)
  );

  tool(server, 'router_set_wifi_password',
    'Cambia la contraseña WiFi de una banda. Activa WPA2/AES automáticamente.',
    {
      band: z.enum(['2.4', '5', '6']).describe('Banda WiFi: "2.4", "5" o "6"'),
      password: z.string().min(8).describe('Nueva contraseña (mínimo 8 caracteres)'),
    },
    ({ band, password }) => router.setWifiPassword(band, password)
  );

  tool(server, 'router_set_wifi_channel',
    'Cambia el canal WiFi de una banda (útil para reducir interferencias).',
    {
      band: z.enum(['2.4', '5', '6']).describe('Banda WiFi: "2.4", "5" o "6"'),
      channel: z.union([z.string(), z.number()]).describe('Canal. 0 = automático. 2.4GHz: 1-11. 5GHz: 36,40,44,48,149,153,157,161'),
    },
    ({ band, channel }) => router.setWifiChannel(band, String(channel))
  );

  tool(server, 'router_toggle_wifi',
    'Enciende o apaga la radio WiFi de una banda.',
    {
      band: z.enum(['2.4', '5', '6']).describe('Banda WiFi: "2.4", "5" o "6"'),
      enable: z.boolean().describe('true para encender, false para apagar'),
    },
    ({ band, enable }) => router.toggleWifi(band, enable)
  );

  tool(server, 'router_get_connected_clients',
    'Lista los dispositivos conectados al router (clientes WiFi y ethernet).',
    {},
    () => router.getConnectedClients()
  );

  tool(server, 'router_get_dhcp_leases',
    'Muestra la configuración DHCP: rango de IPs, tiempo de lease y asignaciones estáticas.',
    {},
    () => router.getDhcpLeases()
  );

  tool(server, 'router_get_mesh_topology',
    'Muestra el estado del mesh AiMesh: nodo principal, nodos satélite y tipo de backhaul.',
    {},
    () => router.getMeshTopology()
  );

  tool(server, 'router_get_mesh_nodes',
    'Lista todos los nodos del mesh AiMesh con su estado de conexión.',
    {},
    () => router.getMeshNodes()
  );

  tool(server, 'router_get_port_forwarding',
    'Lista las reglas de port forwarding y la configuración DMZ.',
    {},
    () => router.getPortForwardingRules()
  );

  tool(server, 'router_add_port_forwarding',
    'Agrega una regla de port forwarding para exponer un servicio interno.',
    {
      name: z.string().describe('Nombre descriptivo de la regla'),
      internal_ip: z.string().describe('IP interna del dispositivo, ej: 192.168.50.100'),
      external_port: z.union([z.string(), z.number()]).describe('Puerto externo o rango, ej: "8080" o "8080:8090"'),
      internal_port: z.union([z.string(), z.number()]).describe('Puerto interno del dispositivo'),
      protocol: z.enum(['TCP', 'UDP', 'BOTH']).default('TCP').describe('Protocolo (default: TCP)'),
    },
    ({ name, internal_ip, external_port, internal_port, protocol }) =>
      router.addPortForwardingRule({
        name,
        internalIp: internal_ip,
        externalPort: String(external_port),
        internalPort: String(internal_port),
        protocol: protocol ?? 'TCP',
      })
  );

  tool(server, 'router_delete_port_forwarding',
    'Elimina una regla de port forwarding por su nombre.',
    {
      rule_name: z.string().describe('Nombre de la regla a eliminar'),
    },
    ({ rule_name }) => router.deletePortForwardingRule(rule_name)
  );

  tool(server, 'router_get_firewall',
    'Muestra el estado del firewall: protección DoS, IPv6 y logs.',
    {},
    () => router.getFirewallSettings()
  );

  tool(server, 'router_get_qos',
    'Obtiene la configuración de QoS: tipo, ancho de banda configurado.',
    {},
    () => router.getQosSettings()
  );

  tool(server, 'router_get_dns_settings',
    'Muestra la configuración DNS: DNS-over-TLS, DNSSEC, DNS del ISP y DNS personalizado.',
    {},
    () => router.getDnsSettings()
  );

  tool(server, 'router_set_custom_dns',
    'Configura servidores DNS personalizados (ej: 1.1.1.1 y 8.8.8.8, o Pi-hole).',
    {
      dns1: z.string().describe('Servidor DNS primario, ej: "1.1.1.1" o "192.168.50.x" para Pi-hole'),
      dns2: z.string().optional().describe('Servidor DNS secundario (opcional)'),
    },
    ({ dns1, dns2 }) => router.setCustomDns(dns1, dns2 ?? '')
  );

  tool(server, 'router_get_ai_protection',
    'Muestra el estado de AiProtection (bloqueo de sitios maliciosos, protección de red).',
    {},
    () => router.getAiProtectionStatus()
  );

  tool(server, 'router_get_lan_settings',
    'Muestra la configuración LAN: IP del router, máscara, rango DHCP.',
    {},
    () => router.getLanSettings()
  );

  tool(server, 'router_get_firmware_info',
    'Muestra la versión de firmware instalada.',
    {},
    () => router.getFirmwareInfo()
  );

  tool(server, 'router_get_traffic_stats',
    'Muestra estadísticas de tráfico de red en tiempo real.',
    {},
    () => router.getTrafficStats()
  );

  tool(server, 'router_run_diagnostic',
    'Ejecuta una herramienta de diagnóstico de red desde el router: ping, nslookup o traceroute.',
    {
      type: z.enum(['ping', 'nslookup', 'traceroute']).describe('Tipo de diagnóstico'),
      target: z.string().describe('Destino: IP o hostname, ej: "8.8.8.8" o "google.com"'),
    },
    ({ type, target }) => router.runDiagnostic(type, target)
  );

  tool(server, 'router_reboot',
    'Reinicia el router. Perderás conectividad durante ~60 segundos. Confirma con el usuario antes de llamar.',
    {},
    () => router.reboot()
  );

  tool(server, 'router_get_system_stats',
    'Muestra estadísticas del sistema del router: uso de CPU, memoria y red.',
    {},
    () => router.getSystemStats()
  );

  // ── MQTT / Mosquitto tools ───────────────────────────────────────────────────

  tool(server, 'mqtt_connect',
    `Registra un broker MQTT con un nombre para usarlo en el resto de herramientas.
Las credenciales se guardan solo en memoria. Soporta brokers sin autenticación, con usuario/contraseña y TLS (mqtts).
Ejemplos: broker local Mosquitto en 192.168.1.x:1883, Home Assistant MQTT add-on, broker en la nube.`,
    {
      name: z.string().describe('Nombre para identificar el broker, ej: "local", "ha", "cloud"'),
      host: z.string().describe('IP o hostname del broker MQTT, ej: "192.168.1.10" o "localhost"'),
      port: z.number().int().default(1883).describe('Puerto del broker (default: 1883, TLS: 8883)'),
      username: z.string().optional().describe('Usuario MQTT (opcional)'),
      password: z.string().optional().describe('Contraseña MQTT (opcional)'),
      tls: z.boolean().default(false).describe('Usar TLS/SSL (mqtts://) — default: false'),
      client_id_prefix: z.string().default('mcp').describe('Prefijo del client ID (default: "mcp")'),
    },
    ({ name, host, port, username, password, tls, client_id_prefix }) =>
      mqttClient.register(name, {
        host,
        port: port ?? 1883,
        username,
        password,
        tls: tls ?? false,
        clientIdPrefix: client_id_prefix ?? 'mcp',
      })
  );

  tool(server, 'mqtt_disconnect',
    'Elimina un broker MQTT registrado de la memoria.',
    { name: z.string().describe('Nombre del broker a eliminar') },
    ({ name }) => mqttClient.unregister(name)
  );

  tool(server, 'mqtt_list_brokers',
    'Lista todos los brokers MQTT registrados (sin mostrar contraseñas).',
    {},
    () => mqttClient.listBrokers()
  );

  tool(server, 'mqtt_test_connection',
    'Prueba la conectividad con un broker MQTT registrado. Útil para verificar host, puerto y credenciales.',
    { broker: z.string().describe('Nombre del broker registrado con mqtt_connect') },
    ({ broker }) => mqttClient.testConnection(broker)
  );

  tool(server, 'mqtt_publish',
    `Publica un mensaje de texto en un topic MQTT.
Soporta QoS 0 (at most once), 1 (at least once) y 2 (exactly once).
Usa retain: true para que el broker guarde el último valor del topic.`,
    {
      broker: z.string().describe('Nombre del broker registrado con mqtt_connect'),
      topic: z.string().describe('Topic MQTT, ej: "casa/salon/temperatura" o "home/light/1/set"'),
      payload: z.string().describe('Contenido del mensaje'),
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0).describe('Nivel de QoS (default: 0)'),
      retain: z.boolean().default(false).describe('Guardar mensaje como retenido en el broker (default: false)'),
    },
    ({ broker, topic, payload, qos, retain }) =>
      mqttClient.publish(broker, topic, payload, { qos: qos ?? 0, retain: retain ?? false })
  );

  tool(server, 'mqtt_publish_json',
    'Publica un objeto JSON como payload en un topic MQTT. Serializa automáticamente el objeto.',
    {
      broker: z.string().describe('Nombre del broker registrado con mqtt_connect'),
      topic: z.string().describe('Topic MQTT destino'),
      payload: z.record(z.unknown()).describe('Objeto JSON a publicar, ej: {"state": "on", "brightness": 200}'),
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0).describe('Nivel de QoS (default: 0)'),
      retain: z.boolean().default(false).describe('Guardar como retenido (default: false)'),
    },
    ({ broker, topic, payload, qos, retain }) =>
      mqttClient.publishJson(broker, topic, payload, { qos: qos ?? 0, retain: retain ?? false })
  );

  tool(server, 'mqtt_subscribe',
    `Suscribe a un topic o patrón MQTT y recoge los mensajes recibidos durante un tiempo.
Soporta wildcards: '+' (un nivel) y '#' (todos los niveles inferiores).
Ejemplos: "casa/#", "sensors/+/temperature", "homeassistant/+/+/state".`,
    {
      broker: z.string().describe('Nombre del broker registrado con mqtt_connect'),
      topic: z.string().describe('Topic o patrón MQTT, ej: "casa/#" o "sensor/+/value"'),
      timeout: z.number().int().positive().default(5000).describe('Tiempo de escucha en milisegundos (default: 5000)'),
      max_messages: z.number().int().positive().default(20).describe('Máximo de mensajes a recoger antes de parar (default: 20)'),
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0).describe('Nivel de QoS (default: 0)'),
    },
    ({ broker, topic, timeout, max_messages, qos }) =>
      mqttClient.subscribe(broker, topic, {
        timeout: timeout ?? 5_000,
        maxMessages: max_messages ?? 20,
        qos: qos ?? 0,
      })
  );

  tool(server, 'mqtt_get_retained',
    'Obtiene el mensaje retenido en un topic específico. Devuelve null si no hay mensaje retenido.',
    {
      broker: z.string().describe('Nombre del broker registrado con mqtt_connect'),
      topic: z.string().describe('Topic exacto del que leer el mensaje retenido'),
    },
    ({ broker, topic }) => mqttClient.getRetained(broker, topic)
  );

  tool(server, 'mqtt_clear_retained',
    'Elimina el mensaje retenido de un topic publicando un payload vacío con retain=true.',
    {
      broker: z.string().describe('Nombre del broker registrado con mqtt_connect'),
      topic: z.string().describe('Topic cuyo mensaje retenido se quiere eliminar'),
    },
    ({ broker, topic }) => mqttClient.clearRetained(broker, topic)
  );

  tool(server, 'mqtt_get_broker_stats',
    `Obtiene estadísticas del broker Mosquitto via el topic especial $SYS.
Devuelve métricas como clientes conectados, mensajes enviados/recibidos, suscripciones activas y versión del broker.
Nota: algunos brokers desactivan $SYS por configuración.`,
    {
      broker: z.string().describe('Nombre del broker registrado con mqtt_connect'),
      timeout: z.number().int().positive().default(4000).describe('Tiempo de espera para recoger stats en ms (default: 4000)'),
    },
    ({ broker, timeout }) => mqttClient.getBrokerStats(broker, { timeout: timeout ?? 4_000 })
  );

  tool(server, 'mqtt_list_topics',
    `Descubre los topics activos en el broker suscribiéndose al wildcard '#' durante un tiempo.
Devuelve la lista de topics únicos que publicaron mensajes en ese intervalo.
Útil para explorar la estructura de topics de un broker nuevo.`,
    {
      broker: z.string().describe('Nombre del broker registrado con mqtt_connect'),
      timeout: z.number().int().positive().default(4000).describe('Tiempo de escucha en milisegundos (default: 4000)'),
      max_messages: z.number().int().positive().default(200).describe('Máximo de mensajes a muestrear (default: 200)'),
    },
    ({ broker, timeout, max_messages }) =>
      mqttClient.listTopics(broker, { timeout: timeout ?? 4_000, maxMessages: max_messages ?? 200 })
  );

  tool(server, 'mqtt_list_clients',
    `Obtiene información sobre clientes conectados al broker Mosquitto via $SYS/broker/clients.
Muestra clientes activos, inactivos, máximo histórico y total de sesiones.
Requiere que el broker publique estadísticas $SYS (habilitado por defecto en Mosquitto).`,
    {
      broker: z.string().describe('Nombre del broker registrado con mqtt_connect'),
    },
    ({ broker }) => mqttClient.listClients(broker)
  );

  return server;
}

// ─── Sesiones stateful ────────────────────────────────────────────────────────

const transports = new Map();    // StreamableHTTP: sessionId → { transport, server }
const sseTransports = new Map(); // SSE:            sessionId → { transport, server }

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS — requerido para clientes de navegador como Open WebUI
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const JENKINS_TOOLS = 20;
const HA_TOOLS = 109;
const PG_TOOLS = 22;
const DOCKER_TOOLS = 19;
const SSH_TOOLS = 12;
const ROUTER_TOOLS = 27;
const MQTT_TOOLS = 12;
const TOTAL_TOOLS = JENKINS_TOOLS + HA_TOOLS + PG_TOOLS + DOCKER_TOOLS + SSH_TOOLS + ROUTER_TOOLS + MQTT_TOOLS;

app.get('/', (_req, res) => {
  res.json({
    name: 'mcp-local-network-admin',
    version: '2.0.0',
    transports: {
      streamableHttp: '/mcp',
      sse: '/sse',
    },
    tools: {
      jenkins: JENKINS_TOOLS,
      homeassistant: HA_TOOLS,
      postgres: PG_TOOLS,
      docker: DOCKER_TOOLS,
      ssh: SSH_TOOLS,
      router: ROUTER_TOOLS,
      mqtt: MQTT_TOOLS,
      total: TOTAL_TOOLS,
    },
    config: {
      jenkins: process.env.JENKINS_URL || 'not configured',
      homeassistant: process.env.HA_URL || 'not configured',
      router: process.env.ASUS_ROUTER_URL || 'not configured',
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

// ─── SSE transport (Open WebUI y clientes MCP legacy) ─────────────────────────

// GET /sse — el cliente abre esta conexión SSE y recibe la URL del endpoint
app.get('/sse', async (req, res) => {
  const server = createServer();
  const transport = new SSEServerTransport('/messages', res);
  sseTransports.set(transport.sessionId, { transport, server });
  transport.onclose = () => sseTransports.delete(transport.sessionId);
  await server.connect(transport);
});

// POST /messages — el cliente envía todos los mensajes JSON-RPC aquí
app.post('/messages', async (req, res) => {
  const { sessionId } = req.query;
  const entry = sseTransports.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'SSE session not found' });
  await entry.transport.handlePostMessage(req, res, req.body);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`\n✅ MCP Local Network Admin v2.0.0`);
  console.log(`   Claude Code (StreamableHTTP): http://localhost:${PORT}/mcp`);
  console.log(`   Open WebUI (SSE):             http://localhost:${PORT}/sse`);
  console.log(`   Health check:                 http://localhost:${PORT}/`);
  console.log(`   Tools: ${JENKINS_TOOLS} Jenkins + ${HA_TOOLS} HA + ${PG_TOOLS} PG + ${DOCKER_TOOLS} Docker + ${SSH_TOOLS} SSH + ${ROUTER_TOOLS} Router = ${TOTAL_TOOLS} total`);
  console.log(`   Jenkins:        ${process.env.JENKINS_URL || '⚠️  no configurado (JENKINS_URL)'}`);
  console.log(`   Home Assistant: ${process.env.HA_URL || '⚠️  no configurado (HA_URL)'}`);
  console.log(`   Router:         ${process.env.ASUS_ROUTER_URL || '⚠️  no configurado (ASUS_ROUTER_URL)'}\n`);
  console.log(`   Claude Code:  claude mcp add --transport http local-network-admin http://localhost:${PORT}/mcp`);
  console.log(`   Open WebUI:   Settings → Tools → add http://<host>:${PORT}/sse\n`);
});

process.on('SIGINT', async () => {
  for (const { transport } of transports.values()) {
    await transport.close().catch(() => {});
  }
  for (const { transport } of sseTransports.values()) {
    await transport.close().catch(() => {});
  }
  process.exit(0);
});
