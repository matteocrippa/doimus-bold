const axios = require("axios");
const FormData = require("form-data");

const API_BASE = "https://api.boldsmartlock.com";
const DEFAULT_REFRESH_URL = "https://bold.nienhuisdevelopment.com/oauth/refresh";
const LEGACY_CLIENT_ID = "BoldApp";
const LEGACY_CLIENT_SECRET = "pgJFgnGB87f9ednFiiHygCbf";

let bold = null;
let devices = new Map();
let refreshTimer = null;

function createBoldAPI(cfg, log) {
  async function req(method, endpoint, body, headers) {
    try {
      const resp = await axios.request({
        method,
        url: `${API_BASE}${endpoint}`,
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          "Content-Type": "application/json",
          ...headers,
        },
        data: body,
      });
      if (resp.data.errorCode && resp.data.errorCode !== "OK") {
        return { success: false, error: { code: resp.data.errorCode, message: resp.data.errorMessage } };
      }
      return { success: true, data: resp.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        return { success: false, error: { code: err.response?.data?.errorCode || err.response?.status || err.code, message: err.response?.data?.errorMessage || `${err}` } };
      }
      return { success: false, error: { message: `${err}` } };
    }
  }

  async function getDevices() {
    log("debug", "Fetching Bold devices...");
    const resp = await req("GET", "/v1/effective-device-permissions");
    if (!resp.success) throw new Error(`getDevices: ${resp.error.message}`);
    if (!Array.isArray(resp.data)) throw new Error("Unexpected /v1/effective-device-permissions format");
    return resp.data.filter((d) => d.id && d.name && d.featureSet?.isActivatable && d.gateway);
  }

  async function activate(deviceId) {
    log("debug", `Activating ${deviceId}...`);
    const resp = await req("POST", `/v1/devices/${deviceId}/remote-activation`);
    if (!resp.success && resp.error.code == 401) {
      log("warn", "Token expired on activation; refreshing...");
      const tokens = await refresh();
      if (tokens) {
        cfg.accessToken = tokens.accessToken;
        cfg.refreshToken = tokens.refreshToken;
        return activate(deviceId);
      }
      return false;
    }
    if (!resp.success) {
      log("error", `Activation failed for ${deviceId}: ${resp.error.message}`);
      return false;
    }
    return true;
  }

  async function refresh() {
    log("debug", "Refreshing Bold access token...");
    if (cfg.legacyAuthentication) {
      const fd = new FormData();
      fd.append("client_id", LEGACY_CLIENT_ID);
      fd.append("client_secret", LEGACY_CLIENT_SECRET);
      fd.append("refresh_token", cfg.refreshToken);
      fd.append("grant_type", "refresh_token");
      const resp = await req("POST", "/v2/oauth/token", fd, fd.getHeaders());
      if (!resp.success) {
        log("error", `Legacy token refresh failed: ${resp.error.message}`);
        return null;
      }
      return { accessToken: resp.data.access_token, refreshToken: resp.data.refresh_token };
    }

    try {
      const resp = await axios.post(cfg.refreshURL || DEFAULT_REFRESH_URL, { refreshToken: cfg.refreshToken });
      const { accessToken, refreshToken } = resp.data.data;
      if (!accessToken || !refreshToken) {
        log("error", `Invalid refresh response: ${JSON.stringify(resp.data)}`);
        return null;
      }
      return { accessToken, refreshToken };
    } catch (err) {
      log("error", `Token refresh error: ${err.message}`);
      return null;
    }
  }

  return { getDevices, activate, refresh };
}

async function syncDevices(cfg, api) {
  try {
    const tokens = await bold.refresh();
    if (tokens) {
      cfg.accessToken = tokens.accessToken;
      cfg.refreshToken = tokens.refreshToken;
    } else {
      api.log("warn", "Token refresh returned nothing; using existing tokens");
    }
  } catch (e) {
    api.log("error", `Token refresh failed: ${e.message}`);
  }

  let remoteDevices;
  try {
    remoteDevices = await bold.getDevices();
  } catch (e) {
    api.log("error", `Device sync failed: ${e.message}. Check that accessToken and refreshToken are valid.`);
    return;
  }

  api.log("info", `Found ${remoteDevices.length} activatable Bold device(s)`);
  if (remoteDevices.length === 0) {
    api.log("warn", "No activatable devices found. Ensure locks are linked to a Bold Connect hub.");
    return;
  }

  const seen = new Set();

  for (const d of remoteDevices) {
    // DeviceType: Lock=1, Connect=2. Connect hub is shown as switch by default.
    const isSwitch = d.type?.id === 2 && !cfg.showControllerAsLock;
    const did = isSwitch ? `bold-switch-${d.id}` : `bold-lock-${d.id}`;
    seen.add(did);

    if (!devices.has(did)) {
      if (isSwitch) {
        api.registerDevice({
          id: did,
          name: d.name,
          type: "switch",
          capabilities: ["on"],
          state: { on: false },
        });
        api.log("info", `Registered switch: ${d.name}`);
      } else {
        api.registerDevice({
          id: did,
          name: d.name,
          type: "lock",
          capabilities: ["locked", "active"],
          state: { locked: true, active: false },
        });
        api.log("info", `Registered lock: ${d.name}`);
      }
      devices.set(did, { device: d, timer: null });
    } else {
      devices.get(did).device = d;
    }
  }

  for (const [did] of devices) {
    if (!seen.has(did)) {
      devices.delete(did);
      api.log("info", `Removed stale device: ${did}`);
    }
  }
}

module.exports = {
  start(cfg, api) {
    const log = (level, msg) => api.log(level, msg);
    bold = createBoldAPI(cfg, log);

    api.onCommand((deviceId, key, value) => {
      for (const [did, state] of devices) {
        if (did !== deviceId) continue;
        const isSwitch = did.startsWith("bold-switch-");

        if (isSwitch) {
          if (key === "on" && value) {
            bold.activate(state.device.id).then((ok) => {
              if (ok) {
                api.updateDeviceState(did, { on: true });
                setTimeout(() => api.updateDeviceState(did, { on: false }), state.device.settings.activationTime * 1000);
              }
            });
          }
        } else {
          if (key === "locked") {
            if (!value) {
              bold.activate(state.device.id).then((ok) => {
                if (ok) {
                  if (state.timer) clearTimeout(state.timer);
                  state.timer = setTimeout(() => {
                    api.updateDeviceState(did, { locked: true, active: false });
                  }, state.device.settings.activationTime * 1000);
                  api.updateDeviceState(did, { locked: false, active: true });
                }
              });
            } else {
              if (state.timer) clearTimeout(state.timer);
              api.updateDeviceState(did, { locked: true, active: false });
            }
          }
        }
        break;
      }
    });

    syncDevices(cfg, api).catch((e) => api.log("error", `Initial sync error: ${e.message}`));
    refreshTimer = setInterval(() => syncDevices(cfg, api).catch((e) => api.log("error", `Periodic sync error: ${e.message}`)), 24 * 60 * 60 * 1000);
    if (refreshTimer.unref) refreshTimer.unref();
  },

  stop() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    for (const [, state] of devices) {
      if (state.timer) clearTimeout(state.timer);
    }
    devices.clear();
    bold = null;
  },
};
