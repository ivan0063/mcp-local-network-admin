/**
 * Home Assistant Client
 * Interactúa con la API REST de Home Assistant.
 * Requiere: HA_URL, HA_TOKEN en .env
 *
 * Documentación: https://developers.home-assistant.io/docs/api/rest/
 */
export class HomeAssistantClient {
  constructor() {
    this.baseUrl = (process.env.HA_URL || '').replace(/\/$/, '');
    this.token = process.env.HA_TOKEN;
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}/api${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Home Assistant ${res.status} en ${path}: ${body.slice(0, 200)}`);
    }

    return res;
  }

  // ─── Estado del sistema ───────────────────────────────────────

  /** Configuración global: versión, timezone, unidades, ubicación */
  async getConfig() {
    const res = await this.request('/config');
    return res.json();
  }

  // ─── Entidades y estados ──────────────────────────────────────

  /**
   * Devuelve TODOS los estados resumidos.
   * Para filtrar por tipo usar getEntitiesByDomain.
   */
  async getAllStates() {
    const res = await this.request('/states');
    const states = await res.json();
    return states.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      friendly_name: s.attributes?.friendly_name,
      area: s.attributes?.area_id,
    }));
  }

  /** Estado completo de una entidad específica (con todos sus atributos) */
  async getEntityState(entityId) {
    const res = await this.request(`/states/${entityId}`);
    return res.json();
  }

  /** Filtra entidades por dominio */
  async getEntitiesByDomain(domain) {
    const res = await this.request('/states');
    const states = await res.json();
    return states
      .filter((s) => s.entity_id.startsWith(`${domain}.`))
      .map((s) => ({
        entity_id: s.entity_id,
        state: s.state,
        friendly_name: s.attributes?.friendly_name,
        attributes: s.attributes,
      }));
  }

  // ─── Control de dispositivos ──────────────────────────────────

  /**
   * Llama a un servicio de HA — acción principal para controlar dispositivos.
   */
  async callService(domain, service, serviceData = {}) {
    const res = await this.request(`/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(serviceData),
    });
    const result = await res.json();
    return {
      success: true,
      action: `${domain}.${service}`,
      affected_entities: result.map?.((s) => s.entity_id) ?? [],
    };
  }

  // ─── Automatizaciones ─────────────────────────────────────────

  /** Lista todas las automatizaciones con su estado (activa/inactiva) */
  async getAutomations() {
    return this.getEntitiesByDomain('automation');
  }

  /** Activa/desactiva una automatización */
  async toggleAutomation(entityId, enable) {
    const service = enable ? 'turn_on' : 'turn_off';
    return this.callService('automation', service, { entity_id: entityId });
  }

  /** Dispara manualmente una automatización */
  async triggerAutomation(entityId) {
    return this.callService('automation', 'trigger', { entity_id: entityId });
  }

  // ─── Escenas ──────────────────────────────────────────────────

  /** Lista todas las escenas disponibles */
  async getScenes() {
    return this.getEntitiesByDomain('scene');
  }

  /** Activa una escena */
  async activateScene(entityId) {
    return this.callService('scene', 'turn_on', { entity_id: entityId });
  }

  // ─── Scripts ──────────────────────────────────────────────────

  /** Lista todos los scripts */
  async getScripts() {
    return this.getEntitiesByDomain('script');
  }

  /** Ejecuta un script, con variables opcionales */
  async runScript(entityId, variables = {}) {
    return this.callService('script', 'turn_on', { entity_id: entityId, variables });
  }

  // ─── Presencia ────────────────────────────────────────────────

  /** Lista personas/presencia en casa */
  async getPersons() {
    return this.getEntitiesByDomain('person');
  }

  // ─── Media players ────────────────────────────────────────────

  /**
   * Controla un media player.
   * action: 'media_play', 'media_pause', 'media_stop', 'volume_set', 'select_source', etc.
   */
  async controlMediaPlayer(entityId, action, extraData = {}) {
    return this.callService('media_player', action, { entity_id: entityId, ...extraData });
  }

  // ─── Notificaciones ───────────────────────────────────────────

  /**
   * Envía una notificación via notify.{service}.
   * notifyService: nombre del servicio después de "notify.", ej: "mobile_app_iphone"
   */
  async sendNotification(notifyService, title, message, data = {}) {
    return this.callService('notify', notifyService, { title, message, ...data });
  }

  // ─── Áreas / Habitaciones ─────────────────────────────────────

  /**
   * Obtiene el área registry via REST (HA 2023.4+).
   * Fallback: inferir áreas desde atributos de entidades.
   */
  async getAreaRegistry() {
    try {
      const res = await this.request('/config/area_registry/list');
      return res.json();
    } catch {
      return this.getAreasFromEntities();
    }
  }

  /**
   * Infiere áreas desde los atributos de las entidades (fallback).
   */
  async getAreasFromEntities() {
    const res = await this.request('/states');
    const states = await res.json();
    const areas = new Map();

    for (const s of states) {
      const area = s.attributes?.area_id || s.attributes?.room;
      if (area) {
        if (!areas.has(area)) areas.set(area, []);
        areas.get(area).push({
          entity_id: s.entity_id,
          friendly_name: s.attributes?.friendly_name,
          state: s.state,
        });
      }
    }

    return Object.fromEntries(areas);
  }

  // ─── Historial y eventos ──────────────────────────────────────

  /** Historial de estados de una entidad (últimas N horas) */
  async getEntityHistory(entityId, hoursAgo = 24) {
    const end = new Date();
    const start = new Date(end - hoursAgo * 3600 * 1000);
    const res = await this.request(
      `/history/period/${start.toISOString()}?filter_entity_id=${entityId}&end_time=${end.toISOString()}`
    );
    const data = await res.json();
    return data[0] || [];
  }

  /** Actividad reciente del logbook (últimas N horas, opcionalmente filtrada por entidad) */
  async getLogbook(hoursAgo = 24, entityId = null) {
    const start = new Date(Date.now() - hoursAgo * 3600 * 1000);
    const path = `/logbook/${start.toISOString()}${entityId ? `?entity_id=${entityId}` : ''}`;
    const res = await this.request(path);
    return res.json();
  }

  /** Dispara un evento personalizado en el bus de HA */
  async fireEvent(eventType, eventData = {}) {
    const res = await this.request(`/events/${eventType}`, {
      method: 'POST',
      body: JSON.stringify(eventData),
    });
    return res.json();
  }

  // ─── Dashboards Lovelace ──────────────────────────────────────

  /** Obtiene la configuración actual del dashboard Lovelace por defecto */
  async getDashboard() {
    const res = await this.request('/lovelace/config');
    return res.json();
  }

  /**
   * Guarda/reemplaza el dashboard Lovelace por defecto.
   * Nota: solo afecta el dashboard por defecto. Requiere modo storage en HA.
   */
  async saveDashboard(config) {
    const res = await this.request('/lovelace/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    return res.json();
  }

  /**
   * Genera y guarda un dashboard Lovelace completo.
   * type: 'rooms' | 'energy' | 'homekit' | 'automations'
   */
  async createLovelaceDashboard(type) {
    let config;

    switch (type) {
      case 'rooms': {
        const areas = await this.getAreaRegistry();
        const allEntities = await this.getAllStates();
        config = buildRoomsDashboard(areas, allEntities);
        break;
      }
      case 'energy': {
        const sensors = await this.getEntitiesByDomain('sensor');
        const energySensors = sensors.filter(s =>
          ['energy', 'power'].includes(s.attributes?.device_class)
        );
        config = buildEnergyDashboard(energySensors);
        break;
      }
      case 'homekit': {
        const entities = await this.getHomekitEntities();
        config = buildHomekitDashboard(entities);
        break;
      }
      case 'automations': {
        const automations = await this.getAutomations();
        config = buildAutomationsDashboard(automations);
        break;
      }
      default:
        throw new Error(`Tipo desconocido: '${type}'. Usa: rooms, energy, homekit, automations`);
    }

    await this.saveDashboard(config);
    return { success: true, type, config };
  }

  // ─── HomeKit ──────────────────────────────────────────────────

  /**
   * Lista entidades compatibles con Apple HomeKit filtradas por dominio.
   */
  async getHomekitEntities() {
    const compatDomains = [
      'light', 'switch', 'climate', 'lock', 'cover', 'fan',
      'sensor', 'binary_sensor', 'alarm_control_panel', 'media_player',
    ];
    const res = await this.request('/states');
    const states = await res.json();
    return states
      .filter(s => compatDomains.some(d => s.entity_id.startsWith(`${d}.`)))
      .map(s => ({
        entity_id: s.entity_id,
        state: s.state,
        friendly_name: s.attributes?.friendly_name,
        domain: s.entity_id.split('.')[0],
        device_class: s.attributes?.device_class ?? null,
        unit: s.attributes?.unit_of_measurement ?? null,
      }));
  }

  /**
   * Resetea un accesorio HomeKit para forzar re-exposición.
   * Requiere integración HomeKit Bridge configurada en HA.
   */
  async resetHomekitAccessory(entityId) {
    return this.callService('homekit', 'reset_accessory', { entity_id: entityId });
  }

  // ─── Sistema ──────────────────────────────────────────────────

  /** Salud del sistema HA: core, red, base de datos, integraciones */
  async getSystemHealth() {
    const res = await this.request('/system_health');
    return res.json();
  }

  // ─── Template rendering ───────────────────────────────────────

  /** Renderiza una plantilla Jinja2 y devuelve el resultado */
  async renderTemplate(template) {
    const res = await this.request('/template', {
      method: 'POST',
      body: JSON.stringify({ template }),
    });
    return res.text();
  }

  // ─── Notificaciones persistentes ──────────────────────────────

  /** Lista las notificaciones persistentes visibles en el panel de HA */
  async listPersistentNotifications() {
    return this.getEntitiesByDomain('persistent_notification');
  }

  /** Crea una notificación persistente en el panel de HA */
  async createPersistentNotification(title, message, notificationId = null) {
    const data = { title, message };
    if (notificationId) data.notification_id = notificationId;
    return this.callService('persistent_notification', 'create', data);
  }

  /** Descarta una notificación persistente por su ID */
  async dismissPersistentNotification(notificationId) {
    return this.callService('persistent_notification', 'dismiss', { notification_id: notificationId });
  }

  // ─── Automatizaciones CRUD ────────────────────────────────────

  /**
   * Lista todas las automatizaciones con su config completa (triggers, actions, etc.).
   * Solo funciona si HA está en modo storage (predeterminado en versiones modernas).
   */
  async listAutomationConfigs() {
    const res = await this.request('/config/automation/config');
    return res.json();
  }

  /** Obtiene la config completa de una automatización por su unique_id */
  async getAutomationConfig(automationId) {
    const res = await this.request(`/config/automation/config/${automationId}`);
    return res.json();
  }

  /**
   * Crea una nueva automatización. HA genera el unique_id si no se incluye.
   * config: { alias, description, trigger, condition, action, mode }
   */
  async createAutomation(config) {
    const res = await this.request('/config/automation/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    return res.json();
  }

  /**
   * Actualiza una automatización existente por su unique_id.
   * Obtén el ID con listAutomationConfigs().
   */
  async updateAutomation(automationId, config) {
    const res = await this.request(`/config/automation/config/${automationId}`, {
      method: 'POST',
      body: JSON.stringify({ ...config, id: automationId }),
    });
    return res.json();
  }

  /** Elimina permanentemente una automatización */
  async deleteAutomation(automationId) {
    await this.request(`/config/automation/config/${automationId}`, { method: 'DELETE' });
    return { success: true, deleted: automationId };
  }

  // ─── Entity Registry ──────────────────────────────────────────

  /**
   * Lista el registro de entidades con metadata: área asignada, nombre override,
   * si está deshabilitada, plataforma de origen, etc.
   */
  async listEntityRegistry(domain = null) {
    const res = await this.request('/config/entity_registry');
    const all = await res.json();
    if (!domain) return all;
    return all.filter(e => e.entity_id.startsWith(`${domain}.`));
  }

  /** Obtiene la entrada del registro para una entidad específica */
  async getEntityRegistryEntry(entityId) {
    const res = await this.request(`/config/entity_registry/${entityId}`);
    return res.json();
  }

  /**
   * Actualiza la entrada del registro de una entidad.
   * Permite renombrar, reasignar área, cambiar entity_id, deshabilitar y cambiar icono.
   */
  async updateEntityRegistryEntry(entityId, { name, newEntityId, areaId, disabled, icon } = {}) {
    const body = {};
    if (name !== undefined) body.name = name;
    if (newEntityId !== undefined) body.new_entity_id = newEntityId;
    if (areaId !== undefined) body.area_id = areaId;
    if (disabled !== undefined) body.disabled_by = disabled ? 'user' : null;
    if (icon !== undefined) body.icon = icon;
    const res = await this.request(`/config/entity_registry/${entityId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** Lista el registro de dispositivos (grupos de entidades por dispositivo físico) */
  async listDeviceRegistry() {
    const res = await this.request('/config/device_registry');
    return res.json();
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Lista helpers. Si domain es null, devuelve todos los tipos.
   * domain: 'input_boolean' | 'input_number' | 'input_select' | 'input_text' | 'counter' | 'timer'
   */
  async listHelpers(domain = null) {
    const domains = domain
      ? [domain]
      : ['input_boolean', 'input_number', 'input_select', 'input_text', 'counter', 'timer'];
    const results = {};
    for (const d of domains) {
      try {
        const res = await this.request(`/config/${d}`);
        const data = await res.json();
        results[d] = data.items ?? (Array.isArray(data) ? data : Object.values(data).filter(v => typeof v === 'object'));
      } catch {
        results[d] = [];
      }
    }
    return domain ? results[domain] : results;
  }

  /**
   * Crea un helper.
   * Ejemplos de config por tipo:
   * input_boolean:  { id, name, icon }
   * input_number:   { id, name, min, max, step, unit_of_measurement, mode }  mode: slider|box
   * input_select:   { id, name, options: [...], icon }
   * input_text:     { id, name, min, max, pattern, mode }  mode: text|password
   * counter:        { id, name, initial, minimum, maximum, step, restore }
   * timer:          { id, name, duration: "HH:MM:SS", restore, icon }
   */
  async createHelper(domain, config) {
    const res = await this.request(`/config/${domain}`, {
      method: 'POST',
      body: JSON.stringify(config),
    });
    return res.json();
  }

  /** Elimina un helper por su dominio e ID */
  async deleteHelper(domain, helperId) {
    await this.request(`/config/${domain}/${helperId}`, { method: 'DELETE' });
    return { success: true, deleted: `${domain}.${helperId}` };
  }

  // ─── Estadísticas de largo plazo ──────────────────────────────

  /**
   * Lista todos los entity_ids que tienen estadísticas de largo plazo almacenadas.
   * Útil para saber qué sensores tienen histórico aggregado disponible.
   */
  async listStatisticIds() {
    const res = await this.request('/recorder/list_statistic_ids');
    return res.json();
  }

  /**
   * Obtiene estadísticas agregadas de una o más entidades.
   * period: '5minute' | 'hour' | 'day' | 'week' | 'month'
   * startTime: ISO 8601, ej: new Date(Date.now() - 30 * 86400000).toISOString()
   */
  async getStatistics(statisticIds, startTime, period = 'day', endTime = null) {
    const body = {
      start_time: startTime,
      statistic_ids: Array.isArray(statisticIds) ? statisticIds : [statisticIds],
      period,
      types: ['min', 'max', 'mean', 'sum', 'state'],
    };
    if (endTime) body.end_time = endTime;
    const res = await this.request('/recorder/statistics_during_period', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // ─── Descubrimiento de servicios ──────────────────────────────

  /** Lista todos los servicios disponibles con sus esquemas de parámetros */
  async getServices(domain = null) {
    const path = domain ? `/services/${domain}` : '/services';
    const res = await this.request(path);
    return res.json();
  }

  // ─── Escenas CRUD ─────────────────────────────────────────────

  /** Crea una nueva escena en modo storage */
  async createScene(config) {
    const res = await this.request('/config/scene/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    return res.json();
  }

  /** Actualiza una escena existente por su ID */
  async updateScene(sceneId, config) {
    const res = await this.request(`/config/scene/config/${sceneId}`, {
      method: 'POST',
      body: JSON.stringify({ ...config, id: sceneId }),
    });
    return res.json();
  }

  /** Elimina una escena por su ID */
  async deleteScene(sceneId) {
    await this.request(`/config/scene/config/${sceneId}`, { method: 'DELETE' });
    return { success: true, deleted: sceneId };
  }

  // ─── Scripts CRUD ─────────────────────────────────────────────

  /** Crea o actualiza un script en modo storage */
  async createOrUpdateScript(scriptId, config) {
    const res = await this.request(`/config/script/config/${scriptId}`, {
      method: 'POST',
      body: JSON.stringify(config),
    });
    return res.json();
  }

  /** Elimina un script por su ID */
  async deleteScript(scriptId) {
    await this.request(`/config/script/config/${scriptId}`, { method: 'DELETE' });
    return { success: true, deleted: scriptId };
  }

  // ─── Operaciones del sistema ──────────────────────────────────

  /** Obtiene info del core de HA: versión, estado, ubicación */
  async getCoreInfo() {
    const res = await this.request('/');
    return res.json();
  }

  /** Valida la configuración YAML sin aplicar cambios */
  async checkConfig() {
    const res = await this.request('/config/core/check_config', { method: 'POST' });
    return res.json();
  }

  /** Reinicia Home Assistant core */
  async restart() {
    await this.request('/config/core/restart', { method: 'POST' });
    return { success: true, message: 'Home Assistant restart initiated. Connectivity will be lost for ~30s.' };
  }

  // ─── Gestión de integraciones ─────────────────────────────────

  /** Lista todas las integraciones/config entries instaladas */
  async listIntegrations() {
    const res = await this.request('/config/config_entries/entry');
    return res.json();
  }

  /** Recarga una integración sin reiniciar HA */
  async reloadIntegration(entryId) {
    const res = await this.request(`/config/config_entries/entry/${entryId}/reload`, {
      method: 'POST',
    });
    return res.json();
  }

  // ─── Add-ons (solo HA OS / Supervised) ───────────────────────

  /** Lista todos los add-ons instalados. Solo disponible en Home Assistant OS o Supervised. */
  async listAddons() {
    const res = await this.request('/hassio/addons');
    const data = await res.json();
    return data?.data?.addons ?? data;
  }

  /** Obtiene info detallada de un add-on */
  async getAddonInfo(slug) {
    const res = await this.request(`/hassio/addons/${slug}/info`);
    const data = await res.json();
    return data?.data ?? data;
  }

  /** Inicia un add-on */
  async startAddon(slug) {
    const res = await this.request(`/hassio/addons/${slug}/start`, { method: 'POST' });
    return res.json();
  }

  /** Detiene un add-on */
  async stopAddon(slug) {
    const res = await this.request(`/hassio/addons/${slug}/stop`, { method: 'POST' });
    return res.json();
  }

  /** Reinicia un add-on */
  async restartAddon(slug) {
    const res = await this.request(`/hassio/addons/${slug}/restart`, { method: 'POST' });
    return res.json();
  }

  // ─── Calendarios ──────────────────────────────────────────────

  /** Lista todos los calendarios integrados en HA */
  async listCalendars() {
    const res = await this.request('/calendars');
    return res.json();
  }

  /**
   * Obtiene los eventos de un calendario en un rango de fechas.
   * start/end: ISO 8601, ej: '2024-12-01T00:00:00.000Z'
   */
  async getCalendarEvents(calendarEntityId, start, end) {
    const params = new URLSearchParams({ start, end });
    const res = await this.request(`/calendars/${calendarEntityId}?${params}`);
    return res.json();
  }

  // ─── Webhooks ─────────────────────────────────────────────────

  /** Dispara un webhook de HA por su ID */
  async triggerWebhook(webhookId, data = {}) {
    const res = await this.request(`/webhook/${webhookId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { result: text }; }
  }

  // ─── Backups ──────────────────────────────────────────────────

  /** Lista todos los backups disponibles */
  async listBackups() {
    const res = await this.request('/backup/info');
    const data = await res.json();
    return data?.data ?? data;
  }

  /** Crea un backup completo. Operación asíncrona — puede tardar varios minutos. */
  async createBackup(name = null) {
    const body = name ? { name } : {};
    const res = await this.request('/backup/full', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data?.data ?? data;
  }

  // ─── Recorder ─────────────────────────────────────────────────

  /** Purga el historial antiguo del recorder manteniendo los últimos N días */
  async purgeHistory(keepDays = 30, repack = false) {
    const res = await this.request('/recorder/purge', {
      method: 'POST',
      body: JSON.stringify({ keep_days: keepDays, repack }),
    });
    return res.json();
  }

  // ─── Floor y Label registries ─────────────────────────────────

  /** Lista los pisos/plantas configurados (HA 2023.9+) */
  async listFloors() {
    const res = await this.request('/config/floor_registry/list');
    return res.json();
  }

  /** Lista las etiquetas configuradas (HA 2024.4+) */
  async listLabels() {
    const res = await this.request('/config/label_registry/list');
    return res.json();
  }

  // ─── Intent ───────────────────────────────────────────────────

  /** Envía un intent de lenguaje natural a HA para ejecutar acciones */
  async handleIntent(name, slots = {}) {
    const res = await this.request('/intent/handle', {
      method: 'POST',
      body: JSON.stringify({ name, data: slots }),
    });
    return res.json();
  }

  // ─── Error log ────────────────────────────────────────────────

  /** Obtiene el log de errores de Home Assistant (texto plano) */
  async getErrorLog() {
    const res = await this.request('/error_log');
    return res.text();
  }

  // ─── Backups (restore y parcial) ──────────────────────────────

  /**
   * Crea un backup parcial seleccionando qué incluir.
   * config: { name, homeassistant, addons, folders, password }
   * folders válidos: 'ssl', 'share', 'addons/local', 'media'
   */
  async createPartialBackup(config) {
    const res = await this.request('/backup/partial', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    const data = await res.json();
    return data?.data ?? data;
  }

  /**
   * Restaura un backup completo por su slug.
   * Obtén el slug con listBackups(). La operación reinicia HA.
   */
  async restoreBackup(slug, password = null) {
    const body = password ? { password } : {};
    const res = await this.request(`/backup/${slug}/restore/full`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data?.data ?? data;
  }
}

// ─── Helpers para generar configs Lovelace ───────────────────────────────────

function buildRoomsDashboard(areas, allEntities) {
  const views = [];

  // Si tenemos áreas del registry (array de objetos con name/id)
  const areaList = Array.isArray(areas)
    ? areas
    : Object.entries(areas).map(([name, entities]) => ({ name, entities }));

  if (areaList.length === 0) {
    // Fallback: un solo view con todas las entidades controlables
    return {
      title: 'Control por Habitación',
      views: [{
        title: 'Todos los dispositivos',
        icon: 'mdi:home',
        cards: [buildEntitiesCard('Luces', allEntities.filter(e => e.entity_id.startsWith('light.')), 'mdi:lightbulb'),
          buildEntitiesCard('Switches', allEntities.filter(e => e.entity_id.startsWith('switch.')), 'mdi:toggle-switch')],
      }],
    };
  }

  for (const area of areaList) {
    const areaEntities = Array.isArray(area.entities)
      ? area.entities
      : allEntities.filter(e => e.area === area.name);

    if (areaEntities.length === 0) continue;

    views.push({
      title: area.name,
      icon: 'mdi:home-outline',
      cards: [
        {
          type: 'entities',
          title: area.name,
          entities: areaEntities.map(e => ({
            entity: e.entity_id ?? e,
            name: e.friendly_name,
          })),
        },
      ],
    });
  }

  if (views.length === 0) {
    views.push({ title: 'Sin áreas', cards: [] });
  }

  return { title: 'Control por Habitación', views };
}

function buildEnergyDashboard(energySensors) {
  const powerSensors = energySensors.filter(s => s.attributes?.device_class === 'power');
  const energySensorsFiltered = energySensors.filter(s => s.attributes?.device_class === 'energy');

  const cards = [];

  if (powerSensors.length > 0) {
    cards.push({
      type: 'entities',
      title: 'Potencia en tiempo real (W)',
      entities: powerSensors.map(s => ({ entity: s.entity_id, name: s.friendly_name })),
    });
    cards.push({
      type: 'history-graph',
      title: 'Historial de potencia',
      hours_to_show: 24,
      entities: powerSensors.slice(0, 5).map(s => ({ entity: s.entity_id })),
    });
  }

  if (energySensorsFiltered.length > 0) {
    cards.push({
      type: 'entities',
      title: 'Consumo acumulado (kWh)',
      entities: energySensorsFiltered.map(s => ({ entity: s.entity_id, name: s.friendly_name })),
    });
  }

  if (cards.length === 0) {
    cards.push({
      type: 'markdown',
      content: 'No se encontraron sensores de energía o potencia en Home Assistant.',
    });
  }

  return {
    title: 'Energía y Consumo',
    views: [{ title: 'Energía', icon: 'mdi:lightning-bolt', cards }],
  };
}

function buildHomekitDashboard(entities) {
  const byDomain = {};
  for (const e of entities) {
    if (!byDomain[e.domain]) byDomain[e.domain] = [];
    byDomain[e.domain].push(e);
  }

  const domainConfig = {
    light: { title: 'Luces', icon: 'mdi:lightbulb' },
    switch: { title: 'Switches', icon: 'mdi:toggle-switch' },
    climate: { title: 'Clima', icon: 'mdi:thermometer' },
    lock: { title: 'Cerraduras', icon: 'mdi:lock' },
    cover: { title: 'Persianas / Puertas', icon: 'mdi:window-shutter' },
    fan: { title: 'Ventiladores', icon: 'mdi:fan' },
    alarm_control_panel: { title: 'Alarma', icon: 'mdi:shield' },
    binary_sensor: { title: 'Sensores binarios', icon: 'mdi:motion-sensor' },
    sensor: { title: 'Sensores', icon: 'mdi:gauge' },
    media_player: { title: 'Media players', icon: 'mdi:speaker' },
  };

  const cards = Object.entries(byDomain).map(([domain, domEntities]) => {
    const cfg = domainConfig[domain] ?? { title: domain, icon: 'mdi:devices' };
    return buildEntitiesCard(cfg.title, domEntities, cfg.icon);
  });

  if (cards.length === 0) {
    cards.push({
      type: 'markdown',
      content: 'No se encontraron entidades compatibles con HomeKit.',
    });
  }

  return {
    title: 'Apple HomeKit',
    views: [{ title: 'HomeKit', icon: 'mdi:apple', cards }],
  };
}

function buildAutomationsDashboard(automations) {
  const active = automations.filter(a => a.state === 'on');
  const inactive = automations.filter(a => a.state === 'off');

  const cards = [];

  if (active.length > 0) {
    cards.push(buildEntitiesCard(`Activas (${active.length})`, active, 'mdi:play-circle'));
  }
  if (inactive.length > 0) {
    cards.push(buildEntitiesCard(`Inactivas (${inactive.length})`, inactive, 'mdi:pause-circle'));
  }
  if (cards.length === 0) {
    cards.push({ type: 'markdown', content: 'No hay automatizaciones configuradas.' });
  }

  return {
    title: 'Automatizaciones',
    views: [{ title: 'Automatizaciones', icon: 'mdi:robot', cards }],
  };
}

function buildEntitiesCard(title, entities, icon) {
  return {
    type: 'entities',
    title,
    icon,
    entities: entities.map(e => ({
      entity: e.entity_id,
      name: e.friendly_name,
    })),
  };
}
