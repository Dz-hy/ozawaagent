import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { Archive, CheckCircle2, Info, Loader2, Shield } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import type { SettingsSectionProps } from "./types";

type AboutSectionProps = SettingsSectionProps;

export function AboutSection(_props: AboutSectionProps) {
  const { t } = useLocale();
  const [archiveOpening, setArchiveOpening] = useState(false);
  const [archiveError, setArchiveError] = useState(false);

  async function handleOpenArchive() {
    if (archiveOpening) return;
    setArchiveOpening(true);
    setArchiveError(false);
    try {
      const archivePath = await invoke<string | null>("app_legacy_archive_dir");
      if (!archivePath) {
        setArchiveError(true);
        return;
      }
      await revealItemInDir(archivePath);
    } catch {
      setArchiveError(true);
    } finally {
      setArchiveOpening(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Info className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t("settings.aboutTitle")}</h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {t("settings.aboutDescription")}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleOpenArchive()}
          disabled={archiveOpening}
        >
          {archiveOpening ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
          {t("settings.aboutOpenArchive")}
        </Button>
      </div>

      {archiveError ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t("settings.aboutArchiveUnavailable")}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("settings.aboutCurrentVersion")}
              </div>
              <div className="mt-1 text-2xl font-semibold leading-none tabular-nums">
                v{__LIVEAGENT_APP_VERSION__}
              </div>
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-xs font-medium">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              {t("settings.aboutCurrentBuild")}
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/70 p-4">
            <div className="mb-2 text-xs font-semibold">{t("settings.aboutNotesTitle")}</div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.aboutNotesBody")}
            </p>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Shield className="h-4 w-4 text-muted-foreground" />
              {t("settings.aboutSecurityTitle")}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.aboutSecurityBody")}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
