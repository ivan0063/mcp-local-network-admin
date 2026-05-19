/**
 * ASUS Router Client — ASUSWRT HTTP API
 *
 * Soporta routers ASUS con firmware ASUSWRT (incluyendo ZenWifi mesh).
 * Auth: sesión HTTP (cookie) obtenida con usuario/contraseña.
 * Configuración: ASUS_ROUTER_URL (ej: http://192.168.50.1) en .env
 *               o pasar la URL directamente en cada llamada.
 *
 * El router principal (node raíz del mesh) expone la API para todos los nodos.
 */
export class AsusRouterClient {
  constructor() {
    this.baseUrl = (process.env.ASUS_ROUTER_URL || '').replace(/\/$/, '');
    this.token = null;
    this.tokenExpires = 0;
    this._user = process.env.ASUS_ROUTER_USER || 'admin';
    this._pass = process.env.ASUS_ROUTER_PASS || '';
  }

  // ─── Auth ──────────────────────────────────────────────────────

  async login(baseUrl = this.baseUrl, username = this._user, password = this._pass) {
    const url = baseUrl || this.baseUrl;
    if (!url) throw new Error('URL del router no configurada. Usa ASUS_ROUTER_URL en .env o pasa baseUrl.');

    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await fetch(`${url}/login.cgi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `login_authorization=${encodeURIComponent(encoded)}`,
    });

    if (!res.ok) throw new Error(`Login falló: HTTP ${res.status}`);
    const text = await res.text();

    // El router responde con JSON {"asus_token": "..."} o con Set-Cookie
    let token = null;
    try {
      const data = JSON.parse(text);
      token = data.asus_token;
    } catch {}

    if (!token) {
      const cookie = res.headers.get('set-cookie') || '';
      const match = cookie.match(/asus_token=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token) throw new Error('No se pudo obtener el token de sesión. Verifica credenciales.');

    this.baseUrl = url;
    this.token = token;
    this.tokenExpires = Date.now() + 20 * 60 * 1000; // 20 min
    this._user = username;
    this._pass = password;
    return { success: true, message: 'Autenticado exitosamente', url };
  }

  async _ensureAuth() {
    if (!this.token || Date.now() > this.tokenExpires) {
      await this.login();
    }
  }

  async _appGet(hook) {
    await this._ensureAuth();
    const res = await fetch(`${this.baseUrl}/appGet.cgi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `asus_token=${this.token}`,
      },
      body: `hook=${encodeURIComponent(hook)}`,
    });
    if (res.status === 401) {
      this.token = null;
      await this.login();
      return this._appGet(hook);
    }
    if (!res.ok) throw new Error(`Router API error: HTTP ${res.status}`);
    return res.text();
  }

  async _applyConfig(payload) {
    await this._ensureAuth();
    const res = await fetch(`${this.baseUrl}/apply.cgi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `asus_token=${this.token}`,
      },
      body: payload,
    });
    if (!res.ok) throw new Error(`apply.cgi error: HTTP ${res.status}`);
    return { success: true };
  }

  _parseNvram(text) {
    const result = {};
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        result[key] = val;
      }
    }
    return result;
  }

  // ─── Estado general ────────────────────────────────────────────

  async getRouterInfo() {
    const raw = await this._appGet(
      'nvram_get(productid);nvram_get(firmver);nvram_get(buildno);nvram_get(extendno);' +
      'nvram_get(wps_device_name);nvram_get(lan_ipaddr);nvram_get(lan_netmask);' +
      'nvram_get(wan0_ipaddr);nvram_get(wan0_gateway);nvram_get(wan0_dns);' +
      'nvram_get(wan0_proto);nvram_get(time_zone);nvram_get(ntp_server0)'
    );
    return this._parseNvram(raw);
  }

  async getWanStatus() {
    const raw = await this._appGet(
      'nvram_get(wan0_ipaddr);nvram_get(wan0_gateway);nvram_get(wan0_dns);' +
      'nvram_get(wan0_proto);nvram_get(wan0_realip_ip);nvram_get(wan0_uptime);' +
      'nvram_get(wan0_link);nvram_get(wan0_ifname)'
    );
    return this._parseNvram(raw);
  }

  async getSystemStats() {
    const raw = await this._appGet(
      'cpu_usage(appobj);memory_usage(appobj);netdev(appobj);uptime(appobj)'
    );
    // El router devuelve JavaScript-like objects, intentamos parsear lo que podamos
    try { return JSON.parse(raw); } catch {}
    return { raw };
  }

  // ─── WiFi ──────────────────────────────────────────────────────

  async getWifiSettings() {
    const raw = await this._appGet(
      // 2.4 GHz
      'nvram_get(wl0_ssid);nvram_get(wl0_auth_mode_x);nvram_get(wl0_channel);' +
      'nvram_get(wl0_chanspec);nvram_get(wl0_radio);nvram_get(wl0_txpower);' +
      'nvram_get(wl0_country_code);nvram_get(wl0_nmode_x);' +
      // 5 GHz band 1
      'nvram_get(wl1_ssid);nvram_get(wl1_auth_mode_x);nvram_get(wl1_channel);' +
      'nvram_get(wl1_chanspec);nvram_get(wl1_radio);nvram_get(wl1_txpower);' +
      'nvram_get(wl1_nmode_x);' +
      // 6 GHz / band 2 (ZenWifi Pro tiene tri-band)
      'nvram_get(wl2_ssid);nvram_get(wl2_radio);nvram_get(wl2_channel);' +
      // Smart Connect / AiMesh
      'nvram_get(smart_connect_x);nvram_get(wl_unit)'
    );
    const cfg = this._parseNvram(raw);
    return {
      band_24ghz: {
        ssid: cfg['wl0_ssid'],
        auth: cfg['wl0_auth_mode_x'],
        channel: cfg['wl0_channel'],
        chanspec: cfg['wl0_chanspec'],
        radio: cfg['wl0_radio'] === '1',
        tx_power: cfg['wl0_txpower'],
        mode: cfg['wl0_nmode_x'],
      },
      band_5ghz: {
        ssid: cfg['wl1_ssid'],
        auth: cfg['wl1_auth_mode_x'],
        channel: cfg['wl1_channel'],
        chanspec: cfg['wl1_chanspec'],
        radio: cfg['wl1_radio'] === '1',
        tx_power: cfg['wl1_txpower'],
        mode: cfg['wl1_nmode_x'],
      },
      band_6ghz: {
        ssid: cfg['wl2_ssid'],
        radio: cfg['wl2_radio'] === '1',
        channel: cfg['wl2_channel'],
      },
      smart_connect: cfg['smart_connect_x'] === '1',
    };
  }

  async setWifiSsid(band, ssid) {
    const bandMap = { '2.4': 'wl0', '5': 'wl1', '6': 'wl2' };
    const prefix = bandMap[band];
    if (!prefix) throw new Error(`Banda inválida: ${band}. Usa "2.4", "5" o "6".`);
    await this._applyConfig(
      `current_page=Advanced_Wireless_Content.asp&action_mode=apply&action_script=restart_wireless&action_wait=8&${prefix}_ssid=${encodeURIComponent(ssid)}`
    );
    return { success: true, band, ssid };
  }

  async setWifiPassword(band, password) {
    const bandMap = { '2.4': 'wl0', '5': 'wl1', '6': 'wl2' };
    const prefix = bandMap[band];
    if (!prefix) throw new Error(`Banda inválida: ${band}. Usa "2.4", "5" o "6".`);
    if (password.length < 8) throw new Error('La contraseña WiFi debe tener al menos 8 caracteres.');
    await this._applyConfig(
      `current_page=Advanced_Wireless_Content.asp&action_mode=apply&action_script=restart_wireless&action_wait=8&${prefix}_wpa_psk=${encodeURIComponent(password)}&${prefix}_auth_mode_x=psk2&${prefix}_crypto=aes`
    );
    return { success: true, band, message: 'Contraseña actualizada' };
  }

  async setWifiChannel(band, channel) {
    const bandMap = { '2.4': 'wl0', '5': 'wl1', '6': 'wl2' };
    const prefix = bandMap[band];
    if (!prefix) throw new Error(`Banda inválida: ${band}. Usa "2.4", "5" o "6".`);
    await this._applyConfig(
      `current_page=Advanced_Wireless_Content.asp&action_mode=apply&action_script=restart_wireless&action_wait=8&${prefix}_channel=${channel}`
    );
    return { success: true, band, channel };
  }

  async toggleWifi(band, enable) {
    const bandMap = { '2.4': 'wl0', '5': 'wl1', '6': 'wl2' };
    const prefix = bandMap[band];
    if (!prefix) throw new Error(`Banda inválida: ${band}. Usa "2.4", "5" o "6".`);
    await this._applyConfig(
      `current_page=Advanced_Wireless_Content.asp&action_mode=apply&action_script=restart_wireless&action_wait=8&${prefix}_radio=${enable ? '1' : '0'}`
    );
    return { success: true, band, enabled: enable };
  }

  // ─── Clientes conectados ───────────────────────────────────────

  async getConnectedClients() {
    const raw = await this._appGet('get_clientlist()');
    // El router devuelve un objeto JSON-like con clientlist
    try {
      const match = raw.match(/get_clientlist\s*=\s*'(.+?)'/s) ||
                    raw.match(/"get_clientlist"\s*:\s*"(.+?)"/s);
      if (match) {
        const parsed = match[1]
          .replace(/\\n/g, '')
          .split(/[<>]/)
          .filter(Boolean);
        return { raw_clients: parsed };
      }
    } catch {}

    // Fallback: ARP table + DHCP leases
    const [arp, leases] = await Promise.allSettled([
      this._appGet('nvram_get(arp_table)'),
      this._appGet('nvram_get(dhcp_staticlist)'),
    ]);
    return {
      arp: arp.status === 'fulfilled' ? this._parseNvram(arp.value) : {},
      dhcp_static: leases.status === 'fulfilled' ? this._parseNvram(leases.value) : {},
      note: 'Para ver clientes en tiempo real usa la UI del router o el endpoint /ajax/networkmap.asp',
    };
  }

  async getDhcpLeases() {
    const raw = await this._appGet(
      'nvram_get(dhcp_start);nvram_get(dhcp_end);nvram_get(lan_ipaddr);' +
      'nvram_get(lan_netmask);nvram_get(dhcp_lease);nvram_get(dhcp_staticlist)'
    );
    return this._parseNvram(raw);
  }

  // ─── AiMesh / Nodos ───────────────────────────────────────────

  async getMeshNodes() {
    const raw = await this._appGet('get_cfg_clientlist()');
    try {
      // El router devuelve la lista de nodos mesh
      return { raw };
    } catch {}
    return { raw };
  }

  async getMeshTopology() {
    const raw = await this._appGet(
      'nvram_get(cfg_device_list);nvram_get(amas_bdl_enabled);' +
      'nvram_get(re_expressway_enable)'
    );
    const cfg = this._parseNvram(raw);

    // Info del nodo actual (principal)
    const main = await this.getRouterInfo();
    return {
      main_node: {
        model: main['productid'],
        ip: main['lan_ipaddr'],
        firmware: `${main['firmver']}.${main['buildno']}`,
      },
      aimesh_nodes: cfg['cfg_device_list'] || 'N/A',
      backhaul_enabled: cfg['amas_bdl_enabled'] === '1',
      expressway: cfg['re_expressway_enable'] === '1',
    };
  }

  // ─── Port Forwarding ──────────────────────────────────────────

  async getPortForwardingRules() {
    const raw = await this._appGet(
      'nvram_get(vts_rulelist);nvram_get(vts_enable_x);' +
      'nvram_get(dmz_ip);nvram_get(dmz_enable)'
    );
    const cfg = this._parseNvram(raw);
    const rules = (cfg['vts_rulelist'] || '')
      .split('<')
      .filter(Boolean)
      .map(rule => {
        const parts = rule.split('>');
        // Formato: name>ip>port_ext_start:port_ext_end>port_int_start:port_int_end>protocol
        return {
          name: parts[0],
          internal_ip: parts[1],
          external_ports: parts[2],
          internal_ports: parts[3],
          protocol: parts[4],
        };
      });
    return {
      enabled: cfg['vts_enable_x'] === '1',
      rules,
      dmz: { enabled: cfg['dmz_enable'] === '1', ip: cfg['dmz_ip'] },
    };
  }

  async addPortForwardingRule({ name, internalIp, externalPort, internalPort, protocol = 'TCP' }) {
    const raw = await this._appGet('nvram_get(vts_rulelist);nvram_get(vts_enable_x)');
    const cfg = this._parseNvram(raw);
    const existing = cfg['vts_rulelist'] || '';
    const newRule = `<${name}>${internalIp}>${externalPort}>${internalPort}>${protocol}`;
    const updated = existing + newRule;

    await this._applyConfig(
      `current_page=Advanced_VirtualServer_Content.asp&action_mode=apply&action_script=restart_firewall&action_wait=4&vts_enable_x=1&vts_rulelist=${encodeURIComponent(updated)}`
    );
    return { success: true, rule: { name, internalIp, externalPort, internalPort, protocol } };
  }

  async deletePortForwardingRule(ruleName) {
    const raw = await this._appGet('nvram_get(vts_rulelist)');
    const cfg = this._parseNvram(raw);
    const existing = cfg['vts_rulelist'] || '';
    const updated = existing
      .split('<')
      .filter(Boolean)
      .filter(r => !r.startsWith(ruleName + '>'))
      .map(r => `<${r}`)
      .join('');

    await this._applyConfig(
      `current_page=Advanced_VirtualServer_Content.asp&action_mode=apply&action_script=restart_firewall&action_wait=4&vts_rulelist=${encodeURIComponent(updated)}`
    );
    return { success: true, deleted: ruleName };
  }

  // ─── QoS y seguridad ──────────────────────────────────────────

  async getQosSettings() {
    const raw = await this._appGet(
      'nvram_get(qos_enable);nvram_get(qos_type);nvram_get(qos_obw);' +
      'nvram_get(qos_ibw);nvram_get(atm_enabled)'
    );
    const cfg = this._parseNvram(raw);
    return {
      qos_enabled: cfg['qos_enable'] === '1',
      type: cfg['qos_type'] === '1' ? 'Adaptive QoS' : cfg['qos_type'] === '2' ? 'Traditional QoS' : 'Bandwidth Monitor',
      upload_mbps: parseInt(cfg['qos_obw'] || '0'),
      download_mbps: parseInt(cfg['qos_ibw'] || '0'),
      adaptive_traffic_management: cfg['atm_enabled'] === '1',
    };
  }

  async getFirewallSettings() {
    const raw = await this._appGet(
      'nvram_get(fw_enable_x);nvram_get(fw_log_x);nvram_get(fw_dos_x);' +
      'nvram_get(fw_filter_x);nvram_get(ipv6_fw_enable)'
    );
    const cfg = this._parseNvram(raw);
    return {
      firewall_enabled: cfg['fw_enable_x'] === '1',
      dos_protection: cfg['fw_dos_x'] === '1',
      logging: cfg['fw_log_x'],
      packet_filter: cfg['fw_filter_x'],
      ipv6_firewall: cfg['ipv6_fw_enable'] === '1',
    };
  }

  async getAiProtectionStatus() {
    const raw = await this._appGet(
      'nvram_get(ASUS_DeployID);nvram_get(TP_HELPER);nvram_get(wrs_enable);' +
      'nvram_get(wrs_protect_enable);nvram_get(wrs_ruleset_x)'
    );
    const cfg = this._parseNvram(raw);
    return {
      ai_protection_enabled: cfg['wrs_enable'] === '1',
      malicious_site_blocking: cfg['wrs_protect_enable'] === '1',
      ruleset: cfg['wrs_ruleset_x'],
    };
  }

  // ─── DNS y LAN ────────────────────────────────────────────────

  async getDnsSettings() {
    const raw = await this._appGet(
      'nvram_get(dnspriv_enable);nvram_get(dns_probe_content);' +
      'nvram_get(wan0_dns);nvram_get(wan1_dns);' +
      'nvram_get(dhcp_dns1_x);nvram_get(dhcp_dns2_x);' +
      'nvram_get(dnssec_enable)'
    );
    const cfg = this._parseNvram(raw);
    return {
      dns_over_tls: cfg['dnspriv_enable'] === '1',
      dnssec: cfg['dnssec_enable'] === '1',
      wan_dns: cfg['wan0_dns'],
      custom_dns_1: cfg['dhcp_dns1_x'],
      custom_dns_2: cfg['dhcp_dns2_x'],
    };
  }

  async setCustomDns(dns1, dns2 = '') {
    await this._applyConfig(
      `current_page=Advanced_DHCP_Content.asp&action_mode=apply&action_script=restart_net_and_phy&action_wait=8&dhcp_dns1_x=${encodeURIComponent(dns1)}&dhcp_dns2_x=${encodeURIComponent(dns2)}`
    );
    return { success: true, dns1, dns2: dns2 || 'not set' };
  }

  async getLanSettings() {
    const raw = await this._appGet(
      'nvram_get(lan_ipaddr);nvram_get(lan_netmask);nvram_get(lan_gateway);' +
      'nvram_get(dhcp_start);nvram_get(dhcp_end);nvram_get(dhcp_lease);' +
      'nvram_get(dhcp_enable_x)'
    );
    return this._parseNvram(raw);
  }

  // ─── Diagnóstico y control ────────────────────────────────────

  async getFirmwareInfo() {
    const raw = await this._appGet(
      'nvram_get(firmver);nvram_get(buildno);nvram_get(extendno);' +
      'nvram_get(productid);nvram_get(force_change)'
    );
    return this._parseNvram(raw);
  }

  async getTrafficStats() {
    const raw = await this._appGet('netdev(appobj)');
    try { return JSON.parse(raw); } catch {}
    return { raw };
  }

  async reboot() {
    await this._ensureAuth();
    const res = await fetch(`${this.baseUrl}/apply.cgi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `asus_token=${this.token}`,
      },
      body: 'current_page=Main_Operation_Content.asp&action_mode=apply&action_script=reboot&action_wait=10',
    });
    return { success: true, message: 'Router reiniciando... estará disponible en ~60 segundos.' };
  }

  async runDiagnostic(type, target = '') {
    const validTypes = ['ping', 'nslookup', 'traceroute'];
    if (!validTypes.includes(type)) throw new Error(`Tipo inválido. Usa: ${validTypes.join(', ')}`);

    const hookMap = {
      ping: `do_ping_test(${target})`,
      nslookup: `do_nslookup(${target})`,
      traceroute: `do_traceroute(${target})`,
    };

    const raw = await this._appGet(hookMap[type]);
    return { type, target, result: raw };
  }

  // ─── Resumen de salud ─────────────────────────────────────────

  async getHealthSummary() {
    const [info, wan, wifi, mesh, fw] = await Promise.allSettled([
      this.getRouterInfo(),
      this.getWanStatus(),
      this.getWifiSettings(),
      this.getMeshTopology(),
      this.getFirewallSettings(),
    ]);

    return {
      router: info.status === 'fulfilled' ? info.value : { error: info.reason?.message },
      wan: wan.status === 'fulfilled' ? wan.value : { error: wan.reason?.message },
      wifi: wifi.status === 'fulfilled' ? wifi.value : { error: wifi.reason?.message },
      mesh: mesh.status === 'fulfilled' ? mesh.value : { error: mesh.reason?.message },
      firewall: fw.status === 'fulfilled' ? fw.value : { error: fw.reason?.message },
    };
  }
}
