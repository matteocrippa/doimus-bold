"use strict";

function createLogger(api, prefix) {
  return (level, msg) => api.log(level, `[${prefix}] ${msg}`);
}

const API_BASE = "https://api.boldsmartlock.com";
const DEFAULT_REFRESH_URL =
  "https://bold.nienhuisdevelopment.com/oauth/refresh";

let bold = null;
let devices = new Map();
let refreshTimer = null;
let savedApi = null;
let log = null;

/**
 * Resolve access + refresh tokens from OAuth SDK first, then fall back to config.
 * AUTH-01: OAuth tokens are injected by the hub and accessed via api.getOAuthToken().
 */
function resolveTokens(cfg, api) {
  // Try OAuth tokens from hub-injected SDK first (AUTH-01)
  const oauth =
    typeof api.getOAuthToken === "function" ? api.getOAuthToken() : null;
  if (oauth && oauth.access_token) {
    return {
      accessToken: oauth.access_token,
      refreshToken: oauth.refresh_token || cfg.refreshToken,
    };
  }
  // Fall back to manually configured tokens
  return {
    accessToken: cfg.accessToken,
    refreshToken: cfg.refreshToken,
  };
}

function createBoldAPI(cfg, api) {
  async function req(method, endpoint, body, headers) {
    const tokens = resolveTokens(cfg, api);
    if (!tokens.accessToken) {
      return {
        success: false,
        error: {
          code: "NOT_AUTHENTICATED",
          message:
            "Bold plugin is not authenticated — complete the OAuth flow or set an access token in the plugin settings.",
        },
      };
    }
    try {
      const resp = await fetch(`${API_BASE}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await resp.json();
      if (data.errorCode && data.errorCode !== "OK") {
        return {
          success: false,
          error: { code: data.errorCode, message: data.errorMessage },
        };
      }
      return { success: true, data };
    } catch (err) {
      return { success: false, error: { message: `${err}` } };
    }
  }

  async function getDevices() {
    log("debug", "Fetching Bold devices...");
    const resp = await req("GET", "/v1/effective-device-permissions");
    if (!resp.success) throw new Error(`getDevices: ${resp.error.message}`);
    if (!Array.isArray(resp.data))
      throw new Error("Unexpected /v1/effective-device-permissions format");
    return resp.data.filter(
      (d) => d.id && d.name && d.featureSet?.isActivatable && d.gateway,
    );
  }

  async function activate(deviceId) {
    log("debug", `Activating ${deviceId}...`);
    const resp = await req("POST", `/v1/devices/${deviceId}/remote-activation`);
    if (!resp.success && resp.error.code == 401) {
      log("warn", "Token expired on activation; refreshing...");
      const tokens = await refresh(cfg, api);
      if (tokens) {
        cfg.accessToken = tokens.accessToken;
        cfg.refreshToken = tokens.refreshToken;
        return activate(deviceId);
      }
      return false;
    }
    if (!resp.success) {
      log(
        "error",
        `Activation failed for ${deviceId}: ${resp.error.message}`,
      );
      return false;
    }
    return true;
  }

  return { getDevices, activate };
}

async function refresh(cfg, api) {
  const tokens = resolveTokens(cfg, api);
  log("debug", "Refreshing Bold access token...");

  try {
    const resp = await fetch(cfg.refreshURL || DEFAULT_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    const data = await resp.json();
    const { accessToken, refreshToken } = data.data;
    if (!accessToken || !refreshToken) {
      log(
        "error",
        `Invalid refresh response: ${JSON.stringify(data)}`,
      );
      return null;
    }
    return { accessToken, refreshToken };
  } catch (err) {
    log("error", `Token refresh error: ${err.message}`);
    return null;
  }
}

async function syncDevices(cfg, api) {
  try {
    const tokens = await refresh(cfg, api);
    if (tokens) {
      cfg.accessToken = tokens.accessToken;
      cfg.refreshToken = tokens.refreshToken;
    } else {
      log("warn", "Token refresh returned nothing; using existing tokens");
    }
  } catch (e) {
    log("error", `Token refresh failed: ${e.message}`);
  }

  let remoteDevices;
  try {
    remoteDevices = await bold.getDevices();
  } catch (e) {
    log(
      "error",
      `Device sync failed: ${e.message}. Check that authentication is valid.`,
    );
    return;
  }

  log("info", `Found ${remoteDevices.length} activatable Bold device(s)`);
  if (remoteDevices.length === 0) {
    log(
      "warn",
      "No activatable devices found. Ensure locks are linked to a Bold Connect hub.",
    );
    return;
  }

  const seen = new Set();

  for (const d of remoteDevices) {
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
        log("info", `Registered switch: ${d.name}`);
      } else {
        api.registerDevice({
          id: did,
          name: d.name,
          type: "lock",
          capabilities: ["locked", "active"],
          state: { locked: true, active: false },
        });
        log("info", `Registered lock: ${d.name}`);
      }
      devices.set(did, { device: d, timer: null });
    } else {
      devices.get(did).device = d;
    }
  }

  for (const [did] of devices) {
    if (!seen.has(did)) {
      devices.delete(did);
      log("info", `Removed stale device: ${did}`);
    }
  }
}

module.exports = {
  start(cfg, api) {
    savedApi = api;
    log = createLogger(api, "Bold");
    bold = createBoldAPI(cfg, api);

    api.onCommand((deviceId, key, value) => {
      for (const [did, state] of devices) {
        if (did !== deviceId) continue;
        const isSwitch = did.startsWith("bold-switch-");

        if (isSwitch) {
          if (key === "on" && value) {
            bold.activate(state.device.id).then((ok) => {
              if (ok) {
                api.updateDeviceState(did, { on: true });
                setTimeout(
                  () => api.updateDeviceState(did, { on: false }),
                  state.device.settings.activationTime * 1000,
                );
              }
            }).catch((error) => {
              log("error", "Activation failed: " + error.message);
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
            }).catch((error) => {
              log("error", "Activation failed: " + error.message);
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

    syncDevices(cfg, api).catch((e) =>
      log("error", `Initial sync error: ${e.message}`),
    );
    refreshTimer = setInterval(
      () =>
        syncDevices(cfg, api).catch((e) =>
          log("error", `Periodic sync error: ${e.message}`),
        ),
      cfg.syncInterval || 86400000,
    );
    if (refreshTimer.unref) refreshTimer.unref();
  },

  setConfig(cfg) {
    this.stop();
    this.start(cfg, savedApi);
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
