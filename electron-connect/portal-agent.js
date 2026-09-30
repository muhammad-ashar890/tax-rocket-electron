const { randomUUID } = require("crypto");

function sanitizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeOrigin(value) {
  return sanitizeBaseUrl(value).toLowerCase();
}

function isOriginAllowed(origin, allowedOrigins = []) {
  if (!origin) {
    return false;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  return allowedOrigins.map(normalizeOrigin).includes(normalizedOrigin);
}

function isBackendAllowed(apiBaseUrl, backendAllowlist = []) {
  if (!apiBaseUrl) {
    return false;
  }

  const normalizedBaseUrl = normalizeOrigin(apiBaseUrl);
  return backendAllowlist.map(normalizeOrigin).includes(normalizedBaseUrl);
}

function createStateStore({ app, fs, path, safeStorage }) {
  function getAgentStatePath() {
    return path.join(app.getPath("userData"), "agent-state.json");
  }

  function encryptJson(value) {
    if (!safeStorage?.isEncryptionAvailable?.()) {
      return JSON.stringify(value);
    }

    const encrypted = safeStorage.encryptString(JSON.stringify(value));
    return JSON.stringify({
      encrypted: true,
      payload: encrypted.toString("base64"),
    });
  }

  function decryptJson(rawValue) {
    if (!rawValue) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawValue);

      if (!parsed?.encrypted || typeof parsed.payload !== "string" || !safeStorage?.isEncryptionAvailable?.()) {
        return parsed;
      }

      const decrypted = safeStorage.decryptString(Buffer.from(parsed.payload, "base64"));
      return JSON.parse(decrypted);
    } catch {
      return null;
    }
  }

  function saveAgentState(state) {
    fs.mkdirSync(path.dirname(getAgentStatePath()), { recursive: true });
    fs.writeFileSync(getAgentStatePath(), encryptJson(state), "utf8");
  }

  function loadAgentState() {
    try {
      const parsed = decryptJson(fs.readFileSync(getAgentStatePath(), "utf8"));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // fall through to default
    }

    const fallback = {
      installationId: randomUUID(),
      deviceAuthToken: "",
      trustedDevicePublicId: "",
      partitionKey: "",
      apiBaseUrl: "",
    };
    saveAgentState(fallback);
    return fallback;
  }

  return {
    getAgentStatePath,
    loadAgentState,
    saveAgentState,
  };
}

module.exports = {
  createStateStore,
  isBackendAllowed,
  isOriginAllowed,
  sanitizeBaseUrl,
};
