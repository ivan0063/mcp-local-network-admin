import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { JenkinsClient } from './tools/jenkins.js';
import { HomeAssistantClient } from './tools/homeassistant.js';
import { PostgresClient } from './tools/postgres.js';
import { DockerClient } from './tools/docker.js';

const jenkins = new JenkinsClient();
const ha = new HomeAssistantClient();
const pg = new PostgresClient();
const docker = new DockerClient();

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
    `Conecta a un servidor Docker remoto vía su API REST y lo registra con un nombre.
La conexión queda disponible para el resto de tools usando ese nombre.

Para exponer la API REST en un lab server Linux:
  Editar /lib/systemd/system/docker.service, agregar a ExecStart:
  -H tcp://0.0.0.0:2375 -H unix:///var/run/docker.sock
  Luego: systemctl daemon-reload && systemctl restart docker`,
    {
      name: z.string().describe('Nombre para identificar este servidor, ej: "lab1", "pi4", "nas"'),
      host: z.string().describe('IP o hostname del servidor Docker, ej: "192.168.1.100"'),
      port: z.number().int().default(2375).describe('Puerto de la API REST (default: 2375)'),
      protocol: z.enum(['http', 'https']).default('http').describe('Protocolo (default: http)'),
    },
    ({ name, host, port, protocol }) => docker.connect(name, host, port ?? 2375, protocol ?? 'http')
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
Para servidores remotos, usa el parámetro host directamente (no necesita docker_connect).

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
      host: z.string().optional().describe('IP del servidor remoto (opcional, omitir para local)'),
      port: z.number().int().default(2375).describe('Puerto Docker del servidor remoto (default: 2375)'),
    },
    ({ project_name, compose_yaml, pull, build, host, port }) =>
      docker.composeUp(project_name, compose_yaml, { pull: pull ?? false, build: build ?? false, host, port: port ?? 2375 })
  );

  tool(server, 'docker_compose_down',
    'Detiene y elimina los contenedores de un stack compose por su nombre de proyecto.',
    {
      project_name: z.string().describe('Nombre del proyecto compose'),
      remove_volumes: z.boolean().default(false).describe('Eliminar también los volúmenes del stack'),
      remove_images: z.boolean().default(false).describe('Eliminar también las imágenes usadas'),
      host: z.string().optional().describe('IP del servidor remoto (opcional, omitir para local)'),
      port: z.number().int().default(2375).describe('Puerto Docker del servidor remoto (default: 2375)'),
    },
    ({ project_name, remove_volumes, remove_images, host, port }) =>
      docker.composeDown(project_name, { removeVolumes: remove_volumes ?? false, removeImages: remove_images ?? false, host, port: port ?? 2375 })
  );

  tool(server, 'docker_list_compose_stacks',
    'Lista los stacks de docker compose activos con sus servicios y estado.',
    { connection: conn },
    ({ connection }) => docker.listComposeStacks(connection ?? 'local')
  );

  return server;
}

// ─── Sesiones stateful ────────────────────────────────────────────────────────

const transports = new Map(); // sessionId → { transport, server }

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const JENKINS_TOOLS = 20;
const HA_TOOLS = 24;
const PG_TOOLS = 22;
const DOCKER_TOOLS = 19;

app.get('/', (_req, res) => {
  res.json({
    name: 'mcp-local-network-admin',
    version: '2.0.0',
    transport: 'StreamableHTTP',
    endpoint: '/mcp',
    tools: { jenkins: JENKINS_TOOLS, homeassistant: HA_TOOLS, postgres: PG_TOOLS, docker: DOCKER_TOOLS, total: JENKINS_TOOLS + HA_TOOLS + PG_TOOLS + DOCKER_TOOLS },
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
  console.log(`   Tools:          ${JENKINS_TOOLS} Jenkins + ${HA_TOOLS} Home Assistant + ${PG_TOOLS} PostgreSQL + ${DOCKER_TOOLS} Docker = ${JENKINS_TOOLS + HA_TOOLS + PG_TOOLS + DOCKER_TOOLS} total`);
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
