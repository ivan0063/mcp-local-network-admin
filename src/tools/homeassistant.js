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

  /** Verifica conectividad y devuelve info de la instancia HA */
  async checkConnection() {
    const res = await this.request('/');
    return res.json();
  }

  /** Configuración global: versión, timezone, unidades, ubicación */
  async getConfig() {
    const res = await this.request('/config');
    return res.json();
  }

  // ─── Entidades y estados ──────────────────────────────────────

  /**
   * Devuelve TODOS los estados de todas las entidades.
   * Incluye lights, switches, sensors, climate, automations, scenes, etc.
   * Nota: puede ser una respuesta grande. Usar getEntitiesByDomain para filtrar.
   */
  async getAllStates() {
    const res = await this.request('/states');
    const states = await res.json();
    // Resumen compacto para no saturar el contexto
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

  /**
   * Filtra entidades por dominio.
   * Dominios comunes: light, switch, climate, sensor, binary_sensor,
   *                   automation, scene, script, media_player, cover, fan
   */
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
   * Llama a un servicio de HA — la acción principal para controlar dispositivos.
   *
   * Ejemplos:
   *   callService('light', 'turn_on', { entity_id: 'light.sala', brightness: 200 })
   *   callService('switch', 'toggle', { entity_id: 'switch.ventilador' })
   *   callService('climate', 'set_temperature', { entity_id: 'climate.ac', temperature: 22 })
   *   callService('scene', 'turn_on', { entity_id: 'scene.cine' })
   *   callService('automation', 'trigger', { entity_id: 'automation.alarma' })
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

  // ─── Áreas / Habitaciones ─────────────────────────────────────

  /**
   * HA no expone el área registry por REST estándar.
   * Esta función infiere áreas desde los atributos de las entidades.
   * Para gestión completa de áreas se recomienda usar el panel de HA.
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

  // ─── Escenas ──────────────────────────────────────────────────

  /** Lista todas las escenas disponibles */
  async getScenes() {
    return this.getEntitiesByDomain('scene');
  }

  /** Activa una escena */
  async activateScene(entityId) {
    return this.callService('scene', 'turn_on', { entity_id: entityId });
  }

  // ─── Historial y eventos ──────────────────────────────────────

  /** Historial de estados de una entidad (últimas 24h por defecto) */
  async getEntityHistory(entityId, hoursAgo = 24) {
    const end = new Date();
    const start = new Date(end - hoursAgo * 3600 * 1000);
    const res = await this.request(
      `/history/period/${start.toISOString()}?filter_entity_id=${entityId}&end_time=${end.toISOString()}`
    );
    const data = await res.json();
    return data[0] || [];
  }

  /** Dispara un evento personalizado en el bus de HA */
  async fireEvent(eventType, eventData = {}) {
    const res = await this.request(`/events/${eventType}`, {
      method: 'POST',
      body: JSON.stringify(eventData),
    });
    return res.json();
  }
}
