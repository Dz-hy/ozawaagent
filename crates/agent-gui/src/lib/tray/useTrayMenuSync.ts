/**
 * 托盘菜单同步 hook：把 ChatPage 作用域内的侧栏快照/工作空间/自动化/设置
 * 组装成 `TrayMenuModel` 并推送 Rust 托盘（`app_tray_menu_sync`）。
 *
 * 接线约束：
 * - 当前 CRUD 模型在前端全量推送（见 trayMenu.ts），Rust 只负责显示；
 * - 外部状态（locale/settings/prefs/automation/workspace）变化与
 *   sidebarStore 内部 revision 变化（会话增删/运行集合）都触发重建；
 * - `syncTrayMenu` 内部有 JSON 签名去抖，重复推送是廉价幂等操作；
 * - 非 Tauri 环境（vite dev / WebUI）invoke 失败静默。
 */
import { useEffect } from "react";
import { useLocale } from "../../i18n/LocaleContext";
import { useAutomation } from "../automation/store";
import { type AppSettings, type WorkspaceProject, workspaceProjectPathKey } from "../settings";
import { selectConversations, selectRunningConversationIds } from "../sidebar/selectors";
import type { SidebarStore } from "../sidebar/store";
import { buildTrayMenuModel, syncTrayMenu } from "./trayMenu";
import { useTrayPrefs } from "./trayPrefs";

export type UseTrayMenuSyncParams = {
  sidebarStore: SidebarStore;
  settings: AppSettings;
  workspaceProjects: readonly WorkspaceProject[];
  activeWorkspaceProjectId: string | null | undefined;
  /** 已归档工作空间的 path key 集合（trayMenu 内以 path key 过滤）。 */
  archivedWorkspaceProjectPathKeys: ReadonlySet<string> | readonly string[];
};

export function useTrayMenuSync(params: UseTrayMenuSyncParams): void {
  const { sidebarStore, settings, workspaceProjects, activeWorkspaceProjectId } = params;
  const { locale } = useLocale();
  const trayPrefs = useTrayPrefs();
  const automation = useAutomation();

  const archivedKeys = new Set(params.archivedWorkspaceProjectPathKeys);
  // trayMenu 期望归档的 path 列表（trayMenu 内部自行过滤这些项目）。
  const archivedWorkspaceProjectPaths = workspaceProjects
    .filter((project) => archivedKeys.has(workspaceProjectPathKey(project.path)))
    .map((project) => project.path);

  useEffect(() => {
    const sync = () => {
      const snapshot = sidebarStore.getSnapshot();
      const model = buildTrayMenuModel({
        locale,
        theme: settings.theme,
        conversations: selectConversations(snapshot),
        runningConversationIds: selectRunningConversationIds(snapshot),
        workspaceProjects,
        activeWorkspaceProjectId: activeWorkspaceProjectId ?? undefined,
        archivedWorkspaceProjectPaths,
        cronTasks: automation.cron.tasks,
        remote: settings.remote,
        // 桌面端当前没有独立的网关在线探测：连接态由 cron/设置表达，
        // 托盘仅显示“已配置/未配置”；未来接入网关心跳后再启用实时值。
        gatewayOnline: false,
        prefs: trayPrefs,
      });
      void syncTrayMenu(model);
    };

    sync();
    return sidebarStore.subscribe(sync);
  }, [
    sidebarStore,
    settings.theme,
    settings.remote,
    workspaceProjects,
    activeWorkspaceProjectId,
    archivedWorkspaceProjectPaths,
    automation.cron.tasks,
    trayPrefs,
    locale,
  ]);
}
