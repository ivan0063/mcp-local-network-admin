import Anthropic from '@anthropic-ai/sdk';
import { JenkinsClient } from './tools/jenkins.js';
import { HomeAssistantClient } from './tools/homeassistant.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const jenkins = new JenkinsClient();
const ha = new HomeAssistantClient();

// ─────────────────────────────────────────────────────────────────
// Definición de herramientas que Claude puede invocar
// ─────────────────────────────────────────────────────────────────

const TOOLS = [
  // ── Jenkins ───────────────────────────────────────────────────
  {
    name: 'jenkins_list_jobs',
    description:
      'Lista todos los jobs/pipelines de Jenkins con su estado actual y resultado del último build. Úsalo primero para descubrir qué existe.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'jenkins_get_job_info',
    description: 'Obtiene información detallada de un job: descripción, URL, builds recientes.',
    input_schema: {
      type: 'object',
      properties: {
        job_name: { type: 'string', description: 'Nombre exacto del job en Jenkins' },
      },
      required: ['job_name'],
    },
  },
  {
    name: 'jenkins_get_job_config',
    description:
      'Obtiene la configuración XML completa de un job, incluyendo el Jenkinsfile/pipeline script. Útil para leer un pipeline antes de copiarlo.',
    input_schema: {
      type: 'object',
      properties: {
        job_name: { type: 'string', description: 'Nombre del job del que obtener la config' },
      },
      required: ['job_name'],
    },
  },
  {
    name: 'jenkins_copy_job',
    description:
      'Crea un nuevo job copiando exactamente la configuración de uno existente. Ideal para "crea el deploy de app X igual que el de app Y".',
    input_schema: {
      type: 'object',
      properties: {
        from_job: { type: 'string', description: 'Job origen (el que se copia)' },
        to_job: { type: 'string', description: 'Nombre del nuevo job a crear' },
      },
      required: ['from_job', 'to_job'],
    },
  },
  {
    name: 'jenkins_create_job',
    description:
      'Crea un nuevo job con una configuración XML personalizada. Úsalo cuando necesites modificar la config antes de crear.',
    input_schema: {
      type: 'object',
      properties: {
        job_name: { type: 'string', description: 'Nombre del nuevo job' },
        config_xml: { type: 'string', description: 'XML de configuración completo del job' },
      },
      required: ['job_name', 'config_xml'],
    },
  },
  {
    name: 'jenkins_update_job_config',
    description: 'Actualiza la configuración XML de un job existente.',
    input_schema: {
      type: 'object',
      properties: {
        job_name: { type: 'string', description: 'Nombre del job a actualizar' },
        config_xml: { type: 'string', description: 'Nueva configuración XML' },
      },
      required: ['job_name', 'config_xml'],
    },
  },
  {
    name: 'jenkins_trigger_build',
    description:
      'Dispara un build para un job. Acepta parámetros opcionales si el job los tiene configurados.',
    input_schema: {
      type: 'object',
      properties: {
        job_name: { type: 'string', description: 'Nombre del job a ejecutar' },
        parameters: {
          type: 'object',
          description: 'Parámetros del build como key-value (ej: {"BRANCH": "main", "ENV": "prod"})',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['job_name'],
    },
  },
  {
    name: 'jenkins_get_build_status',
    description:
      'Obtiene el estado de un build: SUCCESS, FAILURE, RUNNING, etc. Por defecto el último build.',
    input_schema: {
      type: 'object',
      properties: {
        job_name: { type: 'string', description: 'Nombre del job' },
        build_number: {
          type: 'string',
          description: 'Número de build o "lastBuild" para el más reciente',
          default: 'lastBuild',
        },
      },
      required: ['job_name'],
    },
  },
  {
    name: 'jenkins_get_build_log',
    description:
      'Obtiene las últimas 100 líneas del log de un build para diagnóstico de errores.',
    input_schema: {
      type: 'object',
      properties: {
        job_name: { type: 'string', description: 'Nombre del job' },
        build_number: { type: 'string', description: 'Número de build o "lastBuild"', default: 'lastBuild' },
      },
      required: ['job_name'],
    },
  },

  // ── Home Assistant ────────────────────────────────────────────
  {
    name: 'ha_get_all_entities',
    description:
      'Lista todas las entidades de Home Assistant (luces, switches, sensores, clima, etc.) con su estado actual. Úsalo para descubrir qué dispositivos existen.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ha_get_entities_by_domain',
    description:
      'Lista entidades filtradas por tipo/dominio. Mucho más eficiente que traer todo.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description:
            'Dominio a filtrar: light, switch, climate, sensor, binary_sensor, automation, scene, script, media_player, cover, fan',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'ha_get_entity_state',
    description:
      'Obtiene el estado completo y todos los atributos de una entidad específica.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'ID de la entidad, ej: light.sala, switch.ventilador, climate.ac_habitacion',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'ha_call_service',
    description: `Controla dispositivos llamando a un servicio de HA. Ejemplos:
      - Encender luz: domain=light, service=turn_on, data={"entity_id":"light.sala","brightness":200}
      - Apagar switch: domain=switch, service=turn_off, data={"entity_id":"switch.ventilador"}
      - Ajustar temperatura: domain=climate, service=set_temperature, data={"entity_id":"climate.ac","temperature":22}
      - Activar escena: domain=scene, service=turn_on, data={"entity_id":"scene.cine"}
      - Toggle múltiples: data={"entity_id":["light.sala","light.cocina"]}`,
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Dominio del servicio: light, switch, climate, scene, automation, media_player, etc.',
        },
        service: {
          type: 'string',
          description: 'Servicio a llamar: turn_on, turn_off, toggle, set_temperature, etc.',
        },
        service_data: {
          type: 'object',
          description: 'Datos del servicio (entity_id es casi siempre requerido)',
        },
      },
      required: ['domain', 'service'],
    },
  },
  {
    name: 'ha_get_automations',
    description: 'Lista todas las automatizaciones y si están activas o no.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ha_toggle_automation',
    description: 'Activa o desactiva una automatización.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'ID de la automatización, ej: automation.luces_noche' },
        enable: { type: 'boolean', description: 'true para activar, false para desactivar' },
      },
      required: ['entity_id', 'enable'],
    },
  },
  {
    name: 'ha_get_scenes',
    description: 'Lista todas las escenas configuradas en Home Assistant.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ha_get_areas',
    description:
      'Intenta obtener las habitaciones/áreas con sus dispositivos según los atributos de las entidades.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ha_get_config',
    description: 'Obtiene la configuración global de HA: versión, timezone, unidades, ubicación.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ─────────────────────────────────────────────────────────────────
// Ejecución de herramientas
// ─────────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  try {
    switch (name) {
      // Jenkins
      case 'jenkins_list_jobs':         return await jenkins.listJobs();
      case 'jenkins_get_job_info':      return await jenkins.getJobInfo(input.job_name);
      case 'jenkins_get_job_config':    return await jenkins.getJobConfig(input.job_name);
      case 'jenkins_copy_job':          return await jenkins.copyJob(input.from_job, input.to_job);
      case 'jenkins_create_job':        return await jenkins.createJob(input.job_name, input.config_xml);
      case 'jenkins_update_job_config': return await jenkins.updateJobConfig(input.job_name, input.config_xml);
      case 'jenkins_trigger_build':     return await jenkins.triggerBuild(input.job_name, input.parameters ?? {});
      case 'jenkins_get_build_status':  return await jenkins.getBuildStatus(input.job_name, input.build_number ?? 'lastBuild');
      case 'jenkins_get_build_log':     return await jenkins.getBuildLog(input.job_name, input.build_number ?? 'lastBuild');

      // Home Assistant
      case 'ha_get_all_entities':       return await ha.getAllStates();
      case 'ha_get_entities_by_domain': return await ha.getEntitiesByDomain(input.domain);
      case 'ha_get_entity_state':       return await ha.getEntityState(input.entity_id);
      case 'ha_call_service':           return await ha.callService(input.domain, input.service, input.service_data ?? {});
      case 'ha_get_automations':        return await ha.getAutomations();
      case 'ha_toggle_automation':      return await ha.toggleAutomation(input.entity_id, input.enable);
      case 'ha_get_scenes':             return await ha.getScenes();
      case 'ha_get_areas':              return await ha.getAreasFromEntities();
      case 'ha_get_config':             return await ha.getConfig();

      default: throw new Error(`Herramienta desconocida: ${name}`);
    }
  } catch (err) {
    // Devolver el error como resultado para que Claude lo lea y explique
    return { error: true, message: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────
// Prompt de sistema
// ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un asistente de red local con acceso completo a Jenkins (CI/CD) y Home Assistant (domótica).

Tu forma de trabajar:
1. Cuando el usuario pida algo, PRIMERO explora para entender qué existe (lista jobs, lista entidades, etc.)
2. Luego ejecuta la acción solicitada
3. Reporta claramente qué hiciste y el resultado

Ejemplos de cómo razonas:
- "Despliega app X con el pipeline de Y" → lista jobs, identifica ambos, copia/clona el pipeline, dispara el build
- "Enciende las luces de la cocina" → busca entidades de tipo light que contengan "cocina" o "kitchen", las enciende
- "Organiza las automatizaciones por habitación" → trae todas las automatizaciones, agrúpalas por nombre/área y presenta el resumen

Reglas importantes:
- Siempre confirma las acciones DESTRUCTIVAS (eliminar jobs, apagar sistemas críticos) antes de ejecutarlas, preguntando al usuario
- Si una herramienta devuelve un error, explícalo claramente y sugiere alternativas
- Sé conciso en tus respuestas: no des detalles técnicos innecesarios a menos que el usuario los pida
- Responde SIEMPRE en el mismo idioma que usa el usuario`;

// ─────────────────────────────────────────────────────────────────
// Loop agéntico principal
// ─────────────────────────────────────────────────────────────────

/**
 * Procesa un mensaje del usuario y devuelve la respuesta del asistente.
 * Mantiene el historial de conversación para contexto multi-turno.
 *
 * @param {string} userMessage - Mensaje del usuario
 * @param {Array}  history     - Historial previo de la conversación
 * @param {Function} onToolCall - Callback opcional para mostrar progreso en tiempo real
 * @returns {{ text: string, history: Array }}
 */
export async function runAgent(userMessage, history = [], onToolCall = null) {
  const messages = [...history, { role: 'user', content: userMessage }];

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  // Agregar respuesta inicial al historial
  messages.push({ role: 'assistant', content: response.content });

  // Loop: mientras Claude quiera usar herramientas
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      // Notificar al frontend qué herramienta se está usando (para mostrar progreso)
      if (onToolCall) onToolCall({ tool: toolUse.name, input: toolUse.input });

      console.log(`[tool] ${toolUse.name}`, JSON.stringify(toolUse.input));
      const result = await executeTool(toolUse.name, toolUse.input);
      console.log(`[result] ${JSON.stringify(result).slice(0, 300)}`);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    // Devolver resultados a Claude y obtener siguiente respuesta
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });
  }

  // Extraer texto final
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return { text, history: messages };
}
