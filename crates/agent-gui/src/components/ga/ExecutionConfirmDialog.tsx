import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import { confirmationBroker } from "../../lib/ga/confirmationBroker";
import type { GaExecutionConfirmation, GaGovernanceRisk } from "../../lib/ga/types";
import { cn } from "../../lib/shared/utils";
import { Shield, X } from "../icons";
import { Button } from "../ui/button";

const RISK_TONES: Record<GaGovernanceRisk, string> = {
  shell: "bg-orange-500/15 text-orange-600",
  write: "bg-amber-500/15 text-amber-600",
  delete: "bg-red-500/15 text-red-600",
  network: "bg-sky-500/15 text-sky-600",
  credentials: "bg-fuchsia-500/15 text-fuchsia-600",
  scheduled: "bg-violet-500/15 text-violet-600",
};
const CATEGORY_TONES: Record<string, string> = {
  command: "bg-foreground/[0.06] text-muted-foreground",
  connector: "bg-sky-500/10 text-sky-600",
};

type Pending = {
  confirmation: GaExecutionConfirmation;
  respond: (granted: boolean) => void;
};

/**
 * 高危执行确认弹窗（票 05）：进程内唯一订阅者，逐个处理 confirmationBroker
 * 队列；批准/拒绝经回调回传 GaBridgeClient（批准后自动重试原请求）。
 * Portal 到 body 以保证悬浮在设置覆盖层之上；界面语言随应用 locale。
 */
export function ExecutionConfirmDialog() {
  const { t } = useLocale();
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(
    () =>
      confirmationBroker.subscribe((confirmation, respond) => {
        setPending({ confirmation, respond });
      }),
    [],
  );

  if (!pending) return null;
  const { confirmation, respond } = pending;
  const decide = (granted: boolean) => {
    respond(granted);
    setPending(null);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6"
      data-state="open"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/25 backdrop-blur-[2px]"
        onClick={() => decide(false)}
        aria-label={t("governance.confirm.close")}
      />
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border/60 bg-background shadow-[0_20px_60px_-28px_rgba(0,0,0,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-border/40 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600">
              <Shield className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                {t("governance.confirm.title")}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("governance.confirm.description")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => decide(false)}
            aria-label={t("governance.confirm.close")}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
                CATEGORY_TONES[confirmation.category] ??
                  "bg-foreground/[0.06] text-muted-foreground",
              )}
            >
              {t(`governance.category.${confirmation.category}`)}
            </span>
            <code className="min-w-0 flex-1 truncate text-sm font-semibold">
              {confirmation.name}
            </code>
            <span className="shrink-0 rounded-md bg-background/50 px-2 py-0.5 text-xs text-muted-foreground">
              {t(`governance.source.${confirmation.source}`)}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {confirmation.risks.map((risk) => (
              <span
                key={risk}
                className={cn(
                  "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
                  RISK_TONES[risk],
                )}
              >
                {t(`governance.risk.${risk}`)}
              </span>
            ))}
          </div>
          {confirmation.state === "denied" ? (
            <p className="text-xs text-destructive">{t("governance.confirm.deniedNotice")}</p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-4">
          <Button
            type="button"
            variant="ghost"
            className="h-8 gap-1.5 rounded-lg px-3 text-xs font-normal text-foreground/80 shadow-none hover:bg-muted hover:text-foreground"
            onClick={() => decide(false)}
          >
            {t("governance.confirm.deny")}
          </Button>
          <Button
            type="button"
            className="h-8 gap-1.5 rounded-lg px-3 text-xs shadow-none"
            onClick={() => decide(true)}
          >
            {t("governance.confirm.approve")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
