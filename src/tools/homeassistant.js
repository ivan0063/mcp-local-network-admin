import { HomeAssistantWebSocketClient } from './homeassistant-ws.js';

/**
 * Home Assistant Client
 * Interactúa con la API REST de Home Assistant para estados/servicios/historial,
 * y con la API WebSocket para todo lo que ya no existe como endpoint REST en
 * versiones modernas de HA (registries, lovelace, recorder, backups, helpers).
 * Requiere: HA_URL, HA_TOKEN en .env
 *
 * Documentación: https://developers.home-assistant.io/docs/api/rest/
 *                https://developers.home-assistant.io/docs/api/websocket/
 */
export class HomeAssistantClient {
  constructor() {
    this.baseUrl = (process.env.HA_URL || '').replace(/\/$/, '');
    this.token = process.env.HA_TOKEN;
    this.ws = new HomeAssistantWebSocketClient(this.baseUrl, this.token);
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
   * Obtiene el área registry. No existe como endpoint REST en HA moderno —
   * solo via WebSocket (config/area_registry/list).
   */
  async getAreaRegistry() {
    return this.ws.command('config/area_registry/list');
  }

  /**
   * Crea un área/habitación nueva.
   * options: { floorId, icon, picture, aliases, labels, temperatureEntityId, humidityEntityId }
   */
  async createArea(name, options = {}) {
    const { floorId, icon, picture, aliases, labels, temperatureEntityId, humidityEntityId } = options;
    const payload = { name };
    if (floorId !== undefined) payload.floor_id = floorId;
    if (icon !== undefined) payload.icon = icon;
    if (picture !== undefined) payload.picture = picture;
    if (aliases !== undefined) payload.aliases = aliases;
    if (labels !== undefined) payload.labels = labels;
    if (temperatureEntityId !== undefined) payload.temperature_entity_id = temperatureEntityId;
    if (humidityEntityId !== undefined) payload.humidity_entity_id = humidityEntityId;
    return this.ws.command('config/area_registry/create', payload);
  }

  /** Actualiza un área existente (mismos campos opcionales que createArea). */
  async updateArea(areaId, options = {}) {
    const { name, floorId, icon, picture, aliases, labels, temperatureEntityId, humidityEntityId } = options;
    const payload = { area_id: areaId };
    if (name !== undefined) payload.name = name;
    if (floorId !== undefined) payload.floor_id = floorId;
    if (icon !== undefined) payload.icon = icon;
    if (picture !== undefined) payload.picture = picture;
    if (aliases !== undefined) payload.aliases = aliases;
    if (labels !== undefined) payload.labels = labels;
    if (temperatureEntityId !== undefined) payload.temperature_entity_id = temperatureEntityId;
    if (humidityEntityId !== undefined) payload.humidity_entity_id = humidityEntityId;
    return this.ws.command('config/area_registry/update', payload);
  }

  /** Elimina un área. Las entidades/dispositivos que la tenían quedan sin área. */
  async deleteArea(areaId) {
    await this.ws.command('config/area_registry/delete', { area_id: areaId });
    return { success: true, deleted: areaId };
  }

  /** Define el orden de despliegue de las áreas. */
  async reorderAreas(areaIds) {
    return this.ws.command('config/area_registry/reorder', { area_ids: areaIds });
  }

  /**
   * Agrupa las entidades por área, combinando entity_registry (área propia o
   * heredada del dispositivo) con device_registry.
   */
  async getAreasFromEntities() {
    const [areas, entities, devices] = await Promise.all([
      this.ws.command('config/area_registry/list'),
      this.ws.command('config/entity_registry/list'),
      this.ws.command('config/device_registry/list'),
    ]);

    const deviceAreaById = new Map(devices.map((d) => [d.id, d.area_id]));
    const allStates = await this.getAllStates();
    const stateByEntityId = new Map(allStates.map((s) => [s.entity_id, s]));

    const grouped = new Map(areas.map((a) => [a.area_id, { ...a, entities: [] }]));
    for (const entity of entities) {
      const areaId = entity.area_id ?? deviceAreaById.get(entity.device_id);
      if (!areaId || !grouped.has(areaId)) continue;
      const state = stateByEntityId.get(entity.entity_id);
      grouped.get(areaId).entities.push({
        entity_id: entity.entity_id,
        friendly_name: state?.friendly_name ?? entity.name ?? entity.original_name,
        state: state?.state,
      });
    }

    return [...grouped.values()];
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

  /** Obtiene la configuración actual del dashboard Lovelace por defecto (solo WebSocket). */
  async getDashboard() {
    return this.ws.command('lovelace/config', { url_path: null });
  }

  /**
   * Guarda/reemplaza el dashboard Lovelace por defecto (solo WebSocket).
   * Nota: solo afecta el dashboard por defecto. Requiere modo storage en HA.
   */
  async saveDashboard(config) {
    return this.ws.command('lovelace/config/save', { url_path: null, config });
  }

  /**
   * Genera y guarda un dashboard Lovelace completo.
   * type: 'rooms' | 'energy' | 'homekit' | 'automations'
   */
  async createLovelaceDashboard(type) {
    let config;

    switch (type) {
      case 'rooms': {
        const areas = await this.getAreasFromEntities();
        config = buildRoomsDashboard(areas, []);
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

  /** Lista entidades con metadata del registro (config/entity_registry/list, solo WebSocket). */
  async listEntityRegistry(domain = null) {
    const all = await this.ws.command('config/entity_registry/list');
    if (!domain) return all;
    return all.filter(e => e.entity_id.startsWith(`${domain}.`));
  }

  /** Obtiene la entrada del registro para una entidad específica */
  async getEntityRegistryEntry(entityId) {
    return this.ws.command('config/entity_registry/get', { entity_id: entityId });
  }

  /**
   * Actualiza la entrada del registro de una entidad.
   * Permite renombrar, reasignar área, cambiar entity_id, deshabilitar, cambiar icono,
   * y asignar categorías/labels. Funciona igual para automatizaciones y scripts, ya que
   * son entidades (automation.x, script.x) bajo el mismo registro.
   */
  async updateEntityRegistryEntry(entityId, { name, newEntityId, areaId, disabled, hidden, icon, categories, labels, aliases } = {}) {
    const payload = { entity_id: entityId };
    if (name !== undefined) payload.name = name;
    if (newEntityId !== undefined) payload.new_entity_id = newEntityId;
    if (areaId !== undefined) payload.area_id = areaId;
    if (disabled !== undefined) payload.disabled_by = disabled ? 'user' : null;
    if (hidden !== undefined) payload.hidden_by = hidden ? 'user' : null;
    if (icon !== undefined) payload.icon = icon;
    if (categories !== undefined) payload.categories = categories;
    if (labels !== undefined) payload.labels = labels;
    if (aliases !== undefined) payload.aliases = aliases;
    return this.ws.command('config/entity_registry/update', payload);
  }

  /** Lista el registro de dispositivos (config/device_registry/list, solo WebSocket). */
  async listDeviceRegistry() {
    return this.ws.command('config/device_registry/list');
  }

  /**
   * Actualiza un dispositivo: reasignar área (mueve todas sus entidades de un solo golpe,
   * salvo las que tengan área propia forzada), renombrar (name_by_user), deshabilitar o
   * asignar labels.
   */
  async updateDeviceRegistryEntry(deviceId, { areaId, nameByUser, disabled, labels } = {}) {
    const payload = { device_id: deviceId };
    if (areaId !== undefined) payload.area_id = areaId;
    if (nameByUser !== undefined) payload.name_by_user = nameByUser;
    if (disabled !== undefined) payload.disabled_by = disabled ? 'user' : null;
    if (labels !== undefined) payload.labels = labels;
    return this.ws.command('config/device_registry/update', payload);
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
      results[d] = await this.ws.command(`${d}/list`);
    }
    return domain ? results[domain] : results;
  }

  /**
   * Crea un helper. El "id" se genera automáticamente a partir de "name" — no se debe enviar.
   * Ejemplos de config por tipo:
   * input_boolean:  { name, icon }
   * input_number:   { name, min, max, step, unit_of_measurement, mode }  mode: slider|box
   * input_select:   { name, options: [...], icon }
   * input_text:     { name, min, max, pattern, mode }  mode: text|password
   * counter:        { name, initial, minimum, maximum, step, restore }
   * timer:          { name, duration: "HH:MM:SS", restore, icon }
   */
  async createHelper(domain, config) {
    const { id, ...rest } = config;
    return this.ws.command(`${domain}/create`, rest);
  }

  /** Elimina un helper por su dominio e ID */
  async deleteHelper(domain, helperId) {
    await this.ws.command(`${domain}/delete`, { [`${domain}_id`]: helperId });
    return { success: true, deleted: `${domain}.${helperId}` };
  }

  // ─── Estadísticas de largo plazo ──────────────────────────────

  /**
   * Lista todos los entity_ids que tienen estadísticas de largo plazo almacenadas.
   * Útil para saber qué sensores tienen histórico aggregado disponible.
   */
  async listStatisticIds() {
    return this.ws.command('recorder/list_statistic_ids');
  }

  /**
   * Obtiene estadísticas agregadas de una o más entidades.
   * period: '5minute' | 'hour' | 'day' | 'week' | 'month'
   * startTime: ISO 8601, ej: new Date(Date.now() - 30 * 86400000).toISOString()
   */
  async getStatistics(statisticIds, startTime, period = 'day', endTime = null) {
    const payload = {
      start_time: startTime,
      statistic_ids: Array.isArray(statisticIds) ? statisticIds : [statisticIds],
      period,
      types: ['min', 'max', 'mean', 'sum', 'state'],
    };
    if (endTime) payload.end_time = endTime;
    return this.ws.command('recorder/statistics_during_period', payload);
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

  /** @throws {Error} Always — add-ons require Supervisor (HA OS or Supervised). Not available on Container. */
  _requireSupervisor(operation) {
    throw new Error(
      `${operation} requires the Home Assistant Supervisor, which is only available on ` +
      `Home Assistant OS or Supervised installations. ` +
      `Your installation (Container) does not have Supervisor support.`
    );
  }

  /** Lista todos los add-ons instalados. Solo disponible en Home Assistant OS o Supervised. */
  async listAddons() {
    this._requireSupervisor('Add-on management');
  }

  /** Obtiene info detallada de un add-on */
  async getAddonInfo(_slug) {
    this._requireSupervisor('Add-on management');
  }

  /** Inicia un add-on */
  async startAddon(_slug) {
    this._requireSupervisor('Add-on management');
  }

  /** Detiene un add-on */
  async stopAddon(_slug) {
    this._requireSupervisor('Add-on management');
  }

  /** Reinicia un add-on */
  async restartAddon(_slug) {
    this._requireSupervisor('Add-on management');
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

  // ─── Backups (solo WebSocket — backup/info, backup/generate, backup/restore) ──

  /** Lista todos los backups disponibles */
  async listBackups() {
    const data = await this.ws.command('backup/info');
    return data?.backups ?? data;
  }

  /** Crea un backup completo. Operación asíncrona — puede tardar varios minutos. */
  async createBackup(name = null) {
    const payload = {
      agent_ids: ['backup.local'],
      include_homeassistant: true,
      include_all_addons: false,
      include_folders: [],
    };
    if (name) payload.name = name;
    return this.ws.command('backup/generate', payload);
  }

  // ─── Recorder ─────────────────────────────────────────────────

  /** Purga el historial antiguo del recorder manteniendo los últimos N días (servicio recorder.purge) */
  async purgeHistory(keepDays = 30, repack = false) {
    return this.callService('recorder', 'purge', { keep_days: keepDays, repack });
  }

  // ─── Floor y Label registries (solo WebSocket) ─────────────────

  /** Lista los pisos/plantas configurados (HA 2023.9+) */
  async listFloors() {
    return this.ws.command('config/floor_registry/list');
  }

  /** Crea un piso/planta. level: entero para el orden vertical (ej: 0=planta baja, 1=primer piso). */
  async createFloor(name, { aliases, icon, level } = {}) {
    const payload = { name };
    if (aliases !== undefined) payload.aliases = aliases;
    if (icon !== undefined) payload.icon = icon;
    if (level !== undefined) payload.level = level;
    return this.ws.command('config/floor_registry/create', payload);
  }

  /** Actualiza un piso existente. */
  async updateFloor(floorId, { name, aliases, icon, level } = {}) {
    const payload = { floor_id: floorId };
    if (name !== undefined) payload.name = name;
    if (aliases !== undefined) payload.aliases = aliases;
    if (icon !== undefined) payload.icon = icon;
    if (level !== undefined) payload.level = level;
    return this.ws.command('config/floor_registry/update', payload);
  }

  /** Elimina un piso. Las áreas que lo tenían quedan sin piso asignado. */
  async deleteFloor(floorId) {
    await this.ws.command('config/floor_registry/delete', { floor_id: floorId });
    return { success: true, deleted: floorId };
  }

  /** Define el orden de despliegue de los pisos. */
  async reorderFloors(floorIds) {
    return this.ws.command('config/floor_registry/reorder', { floor_ids: floorIds });
  }

  /** Lista las etiquetas configuradas (HA 2024.4+) */
  async listLabels() {
    return this.ws.command('config/label_registry/list');
  }

  /**
   * Crea una etiqueta (label). Las labels son globales (no tienen scope, a diferencia
   * de las categorías) y se pueden asignar a cualquier entidad, área o dispositivo.
   * color: nombre de color de Material Design, ej: "blue", "red", "green" (opcional)
   */
  async createLabel(name, { color, description, icon } = {}) {
    const payload = { name };
    if (color !== undefined) payload.color = color;
    if (description !== undefined) payload.description = description;
    if (icon !== undefined) payload.icon = icon;
    return this.ws.command('config/label_registry/create', payload);
  }

  /** Actualiza nombre/color/descripción/icono de una etiqueta existente. */
  async updateLabel(labelId, { name, color, description, icon } = {}) {
    const payload = { label_id: labelId };
    if (name !== undefined) payload.name = name;
    if (color !== undefined) payload.color = color;
    if (description !== undefined) payload.description = description;
    if (icon !== undefined) payload.icon = icon;
    return this.ws.command('config/label_registry/update', payload);
  }

  /** Elimina una etiqueta. Se desasigna automáticamente de todo lo que la tuviera. */
  async deleteLabel(labelId) {
    await this.ws.command('config/label_registry/delete', { label_id: labelId });
    return { success: true, deleted: labelId };
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
   * config: { name, include_homeassistant, include_all_addons, include_folders, agent_ids }
   * folders válidos: 'ssl', 'share', 'addons/local', 'media'
   */
  async createPartialBackup(config) {
    const payload = {
      agent_ids: config.agent_ids ?? ['backup.local'],
      include_homeassistant: config.include_homeassistant ?? true,
      include_all_addons: config.include_all_addons ?? false,
      include_folders: config.include_folders ?? [],
    };
    if (config.name) payload.name = config.name;
    return this.ws.command('backup/generate', payload);
  }

  /**
   * Restaura un backup completo por su backup_id (slug).
   * Obtén el backup_id con listBackups(). La operación reinicia HA.
   */
  async restoreBackup(slug, password = null) {
    const payload = { backup_id: slug, agent_id: 'backup.local' };
    if (password) payload.password = password;
    return this.ws.command('backup/restore', payload);
  }

  /**
   * Verifica que un backup existe y descargable, devolviendo su tamaño y tipo.
   * No transfiere el contenido binario (evita saturar la respuesta) — usa la URL
   * ${HA_URL}/api/backup/download/{backup_id}?agent_id=...&password=... con el token
   * como Bearer para descargarlo directamente.
   */
  async checkBackupDownload(backupId, agentId = 'backup.local', password = null) {
    const params = new URLSearchParams({ agent_id: agentId });
    if (password) params.set('password', password);
    const res = await this.request(`/backup/download/${backupId}?${params}`);
    return {
      downloadable: true,
      content_type: res.headers.get('content-type'),
      content_length: res.headers.get('content-length'),
      content_disposition: res.headers.get('content-disposition'),
    };
  }

  /**
   * Sube un archivo de backup (.tar) codificado en base64 y lo registra en los agentes indicados.
   */
  async uploadBackupFile(base64Content, filename, agentIds = ['backup.local']) {
    const buffer = Buffer.from(base64Content, 'base64');
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    const params = new URLSearchParams();
    for (const id of agentIds) params.append('agent_id', id);
    const res = await fetch(`${this.baseUrl}/api/backup/upload?${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Home Assistant ${res.status} en /backup/upload: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  // ─── Búsqueda de relaciones ────────────────────────────────────

  /**
   * Encuentra todo lo que referencia a un item (área, automatización, config_entry,
   * dispositivo, entidad, grupo, escena, script o persona). Ideal para saber qué se
   * rompe antes de borrar o renombrar algo.
   */
  async searchRelated(itemType, itemId) {
    return this.ws.command('search/related', { item_type: itemType, item_id: itemId });
  }

  // ─── Trazas de ejecución (debugging) ───────────────────────────

  /** Lista las ejecuciones (traces) registradas de una automatización o script. */
  async listTraces(domain, itemId = null) {
    const payload = { domain };
    if (itemId) payload.item_id = itemId;
    return this.ws.command('trace/list', payload);
  }

  /** Obtiene la traza detallada (paso a paso: triggers, conditions, actions) de una ejecución. */
  async getTrace(domain, itemId, runId) {
    return this.ws.command('trace/get', { domain, item_id: itemId, run_id: runId });
  }

  /** Lista los context_id que tienen traza asociada, útil para seguir cadenas de automatizaciones. */
  async getTraceContexts(domain = null, itemId = null) {
    const payload = {};
    if (domain) payload.domain = domain;
    if (itemId) payload.item_id = itemId;
    return this.ws.command('trace/contexts', payload);
  }

  // ─── Listas de tareas (todo) ────────────────────────────────────

  /** Lista los ítems de una lista de tareas/compras (entidad todo.*). */
  async listTodoItems(entityId) {
    return this.ws.command('todo/item/list', { entity_id: entityId });
  }

  /** Reordena un ítem de una lista de tareas, colocándolo después de previousUid (null = al principio). */
  async moveTodoItem(entityId, uid, previousUid = null) {
    const payload = { entity_id: entityId, uid };
    if (previousUid !== null) payload.previous_uid = previousUid;
    return this.ws.command('todo/item/move', payload);
  }

  // ─── Logbook filtrable (WebSocket) ──────────────────────────────

  /**
   * Consulta el logbook con filtros avanzados (por entidad, dispositivo o context_id),
   * más flexible que getLogbook (que solo filtra por periodo y una entidad).
   */
  async getLogbookEventsFiltered({ startTime, endTime, entityIds, deviceIds, contextId }) {
    const payload = { start_time: startTime };
    if (endTime) payload.end_time = endTime;
    if (entityIds) payload.entity_ids = entityIds;
    if (deviceIds) payload.device_ids = deviceIds;
    if (contextId) payload.context_id = contextId;
    return this.ws.command('logbook/get_events', payload);
  }

  // ─── Estadísticas del recorder (avanzado) ──────────────────────

  /** Detecta inconsistencias en las estadísticas de largo plazo (útil antes de confiar en el dashboard de energía). */
  async validateStatistics() {
    return this.ws.command('recorder/validate_statistics');
  }

  /** Metadata (unidad, nombre, fuente) de una o más estadísticas. Omitir statisticIds para todas. */
  async getStatisticsMetadata(statisticIds = null) {
    const payload = {};
    if (statisticIds) payload.statistic_ids = statisticIds;
    return this.ws.command('recorder/get_statistics_metadata', payload);
  }

  /**
   * Corrige una estadística acumulada (sum) sumando un ajuste en un punto del tiempo.
   * Útil cuando un medidor de energía se reinició y las lecturas quedaron descuadradas.
   */
  async adjustSumStatistics(statisticId, startTime, adjustment, adjustmentUnit = null) {
    return this.ws.command('recorder/adjust_sum_statistics', {
      statistic_id: statisticId,
      start_time: startTime,
      adjustment,
      adjustment_unit_of_measurement: adjustmentUnit,
    });
  }

  // ─── Media source (explorar/buscar contenido reproducible) ─────

  /** Explora el árbol de fuentes de media (medios locales, TTS, etc.). Omitir mediaContentId para la raíz. */
  async browseMedia(mediaContentId = '') {
    return this.ws.command('media_source/browse_media', { media_content_id: mediaContentId });
  }

  /** Busca contenido dentro de una fuente de media. */
  async searchMedia(query, mediaContentId = '', filterClasses = null) {
    const payload = { media_content_id: mediaContentId, search_query: query };
    if (filterClasses) payload.media_filter_classes = filterClasses;
    return this.ws.command('media_source/search_media', payload);
  }

  /** Resuelve un media_content_id a una URL reproducible (con expiración en segundos). */
  async resolveMedia(mediaContentId, expires = null) {
    const payload = { media_content_id: mediaContentId };
    if (expires) payload.expires = expires;
    return this.ws.command('media_source/resolve_media', payload);
  }

  // ─── Dashboard de Energía ───────────────────────────────────────

  /** Metadata de las fuentes de energía configuradas (grid, solar, gas, agua, dispositivos). */
  async getEnergyInfo() {
    return this.ws.command('energy/info');
  }

  /** Preferencias completas del dashboard de Energía (fuentes configuradas y su config). */
  async getEnergyPreferences() {
    return this.ws.command('energy/get_prefs');
  }

  /** Valida la configuración de energía y reporta problemas (sensores faltantes, unidades incorrectas, etc.). */
  async validateEnergyPreferences() {
    return this.ws.command('energy/validate');
  }

  /** Pronóstico de producción solar del día, si hay integración de forecast solar configurada. */
  async getSolarForecast() {
    return this.ws.command('energy/solar_forecast');
  }

  // ─── Categorías ──────────────────────────────────────────────────

  /** Lista las categorías configuradas dentro de un scope (ej: "automation", "script"). */
  async listCategories(scope) {
    return this.ws.command('config/category_registry/list', { scope });
  }

  /** Crea una categoría dentro de un scope. */
  async createCategory(scope, name, icon = null) {
    const payload = { scope, name };
    if (icon !== null) payload.icon = icon;
    return this.ws.command('config/category_registry/create', payload);
  }

  /** Actualiza el nombre/icono de una categoría existente. */
  async updateCategory(scope, categoryId, { name, icon } = {}) {
    const payload = { scope, category_id: categoryId };
    if (name !== undefined) payload.name = name;
    if (icon !== undefined) payload.icon = icon;
    return this.ws.command('config/category_registry/update', payload);
  }

  /** Elimina una categoría de un scope. */
  async deleteCategory(scope, categoryId) {
    await this.ws.command('config/category_registry/delete', { scope, category_id: categoryId });
    return { success: true, deleted: categoryId, scope };
  }

  // ─── Problemas detectados (Repairs) ─────────────────────────────

  /** Lista los problemas/avisos activos detectados por Home Assistant (config deprecada, integraciones fallando, etc.). */
  async listRepairIssues() {
    return this.ws.command('repairs/list_issues');
  }

  /** Obtiene el detalle (placeholders para el flujo de reparación) de un problema específico. */
  async getRepairIssueData(domain, issueId) {
    return this.ws.command('repairs/get_issue_data', { domain, issue_id: issueId });
  }

  // ─── Gestión de integraciones (config entries avanzado) ─────────

  /** Devuelve config entries filtradas por tipo (ej: ["integration"]) y/o dominio — más preciso que listIntegrations(). */
  async getConfigEntries(typeFilter = null, domain = null) {
    const payload = {};
    if (typeFilter) payload.type_filter = typeFilter;
    if (domain) payload.domain = domain;
    return this.ws.command('config_entries/get', payload);
  }

  /** Lista los handlers de integración instalables (para agregar una integración nueva, no solo recargarla). */
  async listAvailableIntegrations(typeFilter = null) {
    const path = typeFilter ? `/config/config_entries/flow_handlers?type=${typeFilter}` : '/config/config_entries/flow_handlers';
    const res = await this.request(path);
    return res.json();
  }

  /** Inicia el flujo de configuración de una integración nueva (o de reconfiguración si se pasa entryId). */
  async startConfigFlow(handler, entryId = null) {
    const body = { handler };
    if (entryId) body.entry_id = entryId;
    const res = await this.request('/config/config_entries/flow', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** Obtiene el paso actual (formulario/schema) de un flujo de configuración en curso. */
  async getConfigFlowStep(flowId) {
    const res = await this.request(`/config/config_entries/flow/${flowId}`);
    return res.json();
  }

  /** Envía los datos de un paso del flujo de configuración y avanza al siguiente. */
  async advanceConfigFlow(flowId, userInput) {
    const res = await this.request(`/config/config_entries/flow/${flowId}`, {
      method: 'POST',
      body: JSON.stringify(userInput),
    });
    return res.json();
  }

  // ─── Red ─────────────────────────────────────────────────────────

  /** Lista los adaptadores de red configurados y su estado. */
  async getNetworkAdapters() {
    return this.ws.command('network');
  }

  /** URLs internas/externas/de Nabu Casa configuradas para acceder a esta instancia. */
  async getNetworkUrls() {
    return this.ws.command('network/url');
  }

  // ─── Conversación / Asistente ────────────────────────────────────

  /**
   * Envía texto libre al motor de conversación de HA (más flexible que handleIntent,
   * que requiere un intent estructurado). Devuelve la respuesta y las acciones ejecutadas.
   */
  async processConversation(text, { conversationId, language, agentId, deviceId } = {}) {
    const payload = { text };
    if (conversationId) payload.conversation_id = conversationId;
    if (language) payload.language = language;
    if (agentId) payload.agent_id = agentId;
    if (deviceId) payload.device_id = deviceId;
    return this.ws.command('conversation/process', payload);
  }

  /** Lista los agentes de conversación disponibles, opcionalmente filtrados por idioma/país. */
  async listConversationAgents(language = null, country = null) {
    const payload = {};
    if (language) payload.language = language;
    if (country) payload.country = country;
    return this.ws.command('conversation/agent/list', payload);
  }

  /** Lista los idiomas soportados por el pipeline de Assist. */
  async listAssistLanguages() {
    return this.ws.command('assist_pipeline/language/list');
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
