import type { AppSettings } from "./index";

export type GatewayProviderApiKeyUpdates = Record<string, string>;
export type GatewaySshSecretUpdates = Record<
  string,
  {
    password?: string;
    privateKey?: string;
    privateKeyPassphrase?: string;
    proxyPassword?: string;
  }
>;
export type GatewaySshSyncPatch = {
  hostChanges?: {
    id: string;
    before: AppSettings["ssh"]["hosts"][number] | null;
    after: AppSettings["ssh"]["hosts"][number] | null;
  }[];
  projectAssociationChanges?: {
    pathKey: string;
    before: string[];
    after: string[];
  }[];
  hostOrderChange?: {
    before: string[];
    after: string[];
  };
};
export type GatewaySettingsSyncProvider = Omit<AppSettings["customProviders"][number], "apiKey"> & {
  apiKeyConfigured?: boolean;
};
export type GatewaySettingsSyncCustomSettings = Partial<AppSettings["customSettings"]>;

export type GatewaySettingsSyncPayload = {
  system: AppSettings["system"];
  customProviders: GatewaySettingsSyncProvider[];
  mcp: AppSettings["mcp"];
  agents: AppSettings["agents"];
  ssh: AppSettings["ssh"];
  memory: AppSettings["memory"];
  customSettings: GatewaySettingsSyncCustomSettings;
  skills: AppSettings["skills"];
  chatRuntimeControls: AppSettings["chatRuntimeControls"];
  selectedModel: AppSettings["selectedModel"] | null;
  theme: AppSettings["theme"];
  locale: AppSettings["locale"];
  sshPatch?: GatewaySshSyncPatch;
  providerApiKeyUpdates?: GatewayProviderApiKeyUpdates;
  sshSecretUpdates?: GatewaySshSecretUpdates;
  // systemProxy 密码回传 sidecar（仿 providerApiKeyUpdates 的简化范式）：
  // system 字段本身出口必被脱敏，明文密码只经此通道回到桌面端落库。
  systemProxyPasswordUpdate?: string;
};
export type GatewaySettingsSyncUpdatePayload = Partial<GatewaySettingsSyncPayload>;

const GATEWAY_SETTINGS_SYNC_FIELDS = [
  "system",
  "customProviders",
  "mcp",
  "agents",
  "ssh",
  "memory",
  "customSettings",
  "skills",
  "chatRuntimeControls",
  "selectedModel",
  "theme",
  "locale",
] as const satisfies readonly (keyof GatewaySettingsSyncPayload)[];

function apiKeyConfiguredForProvider(provider: AppSettings["customProviders"][number]) {
  return provider.apiKey.trim().length > 0 || provider.apiKeyConfigured === true;
}

export function redactCustomProvidersForGateway(
  customProviders: AppSettings["customProviders"],
): GatewaySettingsSyncProvider[] {
  return customProviders.map((provider) => {
    const { apiKey: _apiKey, ...rest } = provider;
    return {
      ...rest,
      apiKeyConfigured: apiKeyConfiguredForProvider(provider),
    };
  });
}

function redactSystemProxyConfig(
  proxy: AppSettings["system"]["systemProxy"],
): AppSettings["system"]["systemProxy"] {
  return {
    ...proxy,
    password: "",
    passwordConfigured: proxy.password.trim().length > 0 || proxy.passwordConfigured === true,
  };
}

function redactSshSettingsForWebStorage(ssh: AppSettings["ssh"]): AppSettings["ssh"] {
  return {
    projectHostAssociations: ssh.projectHostAssociations,
    hosts: ssh.hosts.map((host) => {
      const isKeyboardInteractiveAuth = host.authType === "keyboardInteractive";
      return {
        ...host,
        password: "",
        passwordConfigured:
          !isKeyboardInteractiveAuth &&
          (host.password.trim().length > 0 || host.passwordConfigured === true),
        privateKey: "",
        privateKeyConfigured:
          !isKeyboardInteractiveAuth &&
          (host.privateKey.trim().length > 0 ||
            host.privateKeyPath.trim().length > 0 ||
            host.privateKeyConfigured === true),
        privateKeyPassphrase: "",
        privateKeyPassphraseConfigured:
          !isKeyboardInteractiveAuth &&
          (host.privateKeyPassphrase.trim().length > 0 ||
            host.privateKeyPassphraseConfigured === true),
        proxy: {
          ...host.proxy,
          password: "",
          passwordConfigured:
            host.proxy.password.trim().length > 0 || host.proxy.passwordConfigured === true,
        },
      };
    }),
  };
}

function collectProviderApiKeyUpdates(
  customProviders: AppSettings["customProviders"],
): GatewayProviderApiKeyUpdates | undefined {
  const updates: GatewayProviderApiKeyUpdates = {};
  for (const provider of customProviders) {
    const apiKey = provider.apiKey.trim();
    if (provider.id.trim() && apiKey) {
      updates[provider.id] = apiKey;
    }
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

export function collectSshSecretUpdates(
  ssh: AppSettings["ssh"],
): GatewaySshSecretUpdates | undefined {
  const updates: GatewaySshSecretUpdates = {};
  for (const host of ssh.hosts) {
    const id = host.id.trim();
    if (!id) continue;
    // keyboardInteractive hosts store no login secrets, but proxy credentials
    // are independent of the auth type and must still sync.
    const isKeyboardInteractiveAuth = host.authType === "keyboardInteractive";
    const password = isKeyboardInteractiveAuth ? "" : host.password.trim();
    const privateKey = isKeyboardInteractiveAuth ? "" : host.privateKey.trim();
    const privateKeyPassphrase = isKeyboardInteractiveAuth ? "" : host.privateKeyPassphrase.trim();
    const proxyPassword = host.proxy.password.trim();
    const update: GatewaySshSecretUpdates[string] = {};
    if (password) update.password = password;
    if (privateKey) update.privateKey = privateKey;
    if (privateKeyPassphrase) update.privateKeyPassphrase = privateKeyPassphrase;
    if (proxyPassword) update.proxyPassword = proxyPassword;
    if (Object.keys(update).length > 0) {
      updates[id] = update;
    }
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

function readSecret(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function collectChangedSshSecretUpdates(
  prev: AppSettings["ssh"],
  next: AppSettings["ssh"],
): GatewaySshSecretUpdates | undefined {
  const previousHostsById = new Map(prev.hosts.map((host) => [host.id, host]));
  const updates: GatewaySshSecretUpdates = {};

  for (const host of next.hosts) {
    const id = host.id.trim();
    if (!id) continue;
    const previous = previousHostsById.get(id);
    const update: GatewaySshSecretUpdates[string] = {};

    if (host.authType === "password") {
      const password = readSecret(host.password);
      const passwordConfiguredCleared =
        previous?.passwordConfigured === true && host.passwordConfigured === false;
      if (password !== readSecret(previous?.password) || passwordConfiguredCleared) {
        update.password = password;
      }
    }

    if (host.authType === "privateKey") {
      const privateKey = readSecret(host.privateKey);
      const privateKeyPassphrase = readSecret(host.privateKeyPassphrase);
      const privateKeyConfiguredCleared =
        previous?.privateKeyConfigured === true && host.privateKeyConfigured === false;
      const privateKeyPassphraseConfiguredCleared =
        previous?.privateKeyPassphraseConfigured === true &&
        host.privateKeyPassphraseConfigured === false;
      if (privateKey !== readSecret(previous?.privateKey) || privateKeyConfiguredCleared) {
        update.privateKey = privateKey;
      }
      if (
        privateKeyPassphrase !== readSecret(previous?.privateKeyPassphrase) ||
        privateKeyPassphraseConfiguredCleared
      ) {
        update.privateKeyPassphrase = privateKeyPassphrase;
      }
    }

    const proxyPassword = readSecret(host.proxy.password);
    const proxyPasswordConfiguredCleared =
      previous?.proxy.passwordConfigured === true && host.proxy.passwordConfigured === false;
    if (proxyPassword !== readSecret(previous?.proxy.password) || proxyPasswordConfiguredCleared) {
      update.proxyPassword = proxyPassword;
    }

    if (Object.keys(update).length > 0) {
      updates[id] = update;
    }
  }

  return Object.keys(updates).length > 0 ? updates : undefined;
}

function redactSshSettingsForGateway(ssh: AppSettings["ssh"]): AppSettings["ssh"] {
  return redactSshSettingsForWebStorage(ssh);
}

function idsEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeAssociationEntries(associations: AppSettings["ssh"]["projectHostAssociations"]) {
  return Object.entries(associations).sort(([left], [right]) => left.localeCompare(right));
}

export function buildGatewaySshSyncPatch(
  prev: AppSettings["ssh"],
  next: AppSettings["ssh"],
): GatewaySshSyncPatch | undefined {
  const previousSsh = redactSshSettingsForGateway(prev);
  const nextSsh = redactSshSettingsForGateway(next);
  const previousHostsById = new Map(previousSsh.hosts.map((host) => [host.id, host]));
  const nextHostsById = new Map(nextSsh.hosts.map((host) => [host.id, host]));
  const hostChanges: NonNullable<GatewaySshSyncPatch["hostChanges"]> = [];
  const seenHostIds = new Set<string>();

  for (const host of previousSsh.hosts) seenHostIds.add(host.id);
  for (const host of nextSsh.hosts) seenHostIds.add(host.id);

  for (const hostId of seenHostIds) {
    const before = previousHostsById.get(hostId) ?? null;
    const after = nextHostsById.get(hostId) ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      hostChanges.push({ id: hostId, before, after });
    }
  }

  const previousOrder = previousSsh.hosts.map((host) => host.id);
  const nextOrder = nextSsh.hosts.map((host) => host.id);
  const sameHostSet =
    previousOrder.length === nextOrder.length && previousOrder.every((id) => nextHostsById.has(id));
  const hostOrderChange =
    sameHostSet && !idsEqual(previousOrder, nextOrder)
      ? { before: previousOrder, after: nextOrder }
      : undefined;

  const projectAssociationChanges: NonNullable<GatewaySshSyncPatch["projectAssociationChanges"]> =
    [];
  const previousAssociations = normalizeAssociationEntries(previousSsh.projectHostAssociations);
  const nextAssociations = normalizeAssociationEntries(nextSsh.projectHostAssociations);
  const pathKeys = new Set<string>([
    ...previousAssociations.map(([pathKey]) => pathKey),
    ...nextAssociations.map(([pathKey]) => pathKey),
  ]);
  for (const pathKey of pathKeys) {
    const before = previousSsh.projectHostAssociations[pathKey] ?? [];
    const after = nextSsh.projectHostAssociations[pathKey] ?? [];
    if (!idsEqual(before, after)) {
      projectAssociationChanges.push({ pathKey, before, after });
    }
  }

  const patch: GatewaySshSyncPatch = {};
  if (hostChanges.length > 0) patch.hostChanges = hostChanges;
  if (projectAssociationChanges.length > 0) {
    patch.projectAssociationChanges = projectAssociationChanges;
  }
  if (hostOrderChange) patch.hostOrderChange = hostOrderChange;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function syncableCustomSettings(
  customSettings: AppSettings["customSettings"],
): GatewaySettingsSyncCustomSettings {
  return {
    ...customSettings,
    chatSidebar: {
      projectsCollapsed: false,
      recentCollapsed: false,
    },
    // fontScale 是本机 UI 偏好：固定为默认值，避免本地调整触发网关广播
    fontScale: { sidebar: 1, chat: 1, rightDock: 1 },
  };
}

function syncableSystemSettings(system: AppSettings["system"]): AppSettings["system"] {
  const syncableSystem = {
    ...system,
    // systemProxy 密码不随 system 字段出站（明文只走 systemProxyPasswordUpdate sidecar）。
    systemProxy: redactSystemProxyConfig(system.systemProxy),
  };
  delete syncableSystem.activeWorkspaceProjectId;
  return syncableSystem as AppSettings["system"];
}

function collectSystemProxyPasswordUpdate(system: AppSettings["system"]): string | undefined {
  const password = system.systemProxy.password;
  return typeof password === "string" && password.trim() ? password : undefined;
}

export function buildGatewaySettingsSyncPayload(
  settings: AppSettings,
  options: { includeProviderApiKeyUpdates?: boolean } = {},
): GatewaySettingsSyncPayload {
  const payload: GatewaySettingsSyncPayload = {
    system: syncableSystemSettings(settings.system),
    customProviders: redactCustomProvidersForGateway(settings.customProviders),
    mcp: settings.mcp,
    agents: settings.agents,
    ssh: redactSshSettingsForGateway(settings.ssh),
    memory: settings.memory,
    customSettings: syncableCustomSettings(settings.customSettings),
    skills: settings.skills,
    chatRuntimeControls: settings.chatRuntimeControls,
    selectedModel: settings.selectedModel ?? null,
    theme: settings.theme,
    locale: settings.locale,
  };
  const providerApiKeyUpdates = options.includeProviderApiKeyUpdates
    ? collectProviderApiKeyUpdates(settings.customProviders)
    : undefined;
  if (providerApiKeyUpdates) {
    payload.providerApiKeyUpdates = providerApiKeyUpdates;
  }
  const sshSecretUpdates = options.includeProviderApiKeyUpdates
    ? collectSshSecretUpdates(settings.ssh)
    : undefined;
  if (sshSecretUpdates) {
    payload.sshSecretUpdates = sshSecretUpdates;
  }
  const systemProxyPasswordUpdate = options.includeProviderApiKeyUpdates
    ? collectSystemProxyPasswordUpdate(settings.system)
    : undefined;
  if (systemProxyPasswordUpdate !== undefined) {
    payload.systemProxyPasswordUpdate = systemProxyPasswordUpdate;
  }
  return payload;
}

export function buildGatewaySettingsSyncUpdatePayload(
  prev: AppSettings,
  next: AppSettings,
  options: { includeProviderApiKeyUpdates?: boolean } = {},
): GatewaySettingsSyncUpdatePayload {
  const previousPayload = buildGatewaySettingsSyncPayload(prev);
  const nextPayload = buildGatewaySettingsSyncPayload(next);
  const update: GatewaySettingsSyncUpdatePayload = {};
  const sshPatch = buildGatewaySshSyncPatch(prev.ssh, next.ssh);

  for (const field of GATEWAY_SETTINGS_SYNC_FIELDS) {
    if (field === "ssh") {
      if (sshPatch) {
        update.sshPatch = sshPatch;
      }
      continue;
    }
    if (JSON.stringify(previousPayload[field]) !== JSON.stringify(nextPayload[field])) {
      (update as Record<string, unknown>)[field] = nextPayload[field];
    }
  }

  const providerApiKeyUpdates = options.includeProviderApiKeyUpdates
    ? collectProviderApiKeyUpdates(next.customProviders)
    : undefined;
  if (providerApiKeyUpdates) {
    update.customProviders ??= nextPayload.customProviders;
    update.providerApiKeyUpdates = providerApiKeyUpdates;
  }
  const sshSecretUpdates = options.includeProviderApiKeyUpdates
    ? collectChangedSshSecretUpdates(prev.ssh, next.ssh)
    : undefined;
  if (sshSecretUpdates) {
    update.sshPatch ??= sshPatch ?? {};
    update.sshSecretUpdates = sshSecretUpdates;
  }
  const systemProxyPasswordUpdate = options.includeProviderApiKeyUpdates
    ? collectSystemProxyPasswordUpdate(next.system)
    : undefined;
  if (systemProxyPasswordUpdate !== undefined) {
    // sidecar 必须与（脱敏后的）system 字段成对出现，接收端才能定位回填目标。
    update.system ??= nextPayload.system;
    update.systemProxyPasswordUpdate = systemProxyPasswordUpdate;
  }

  return update;
}
