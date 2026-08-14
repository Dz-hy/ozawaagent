import type { GaExecutionConfirmation } from "./types";

type Respond = (granted: boolean) => void;
type BrokerListener = (confirmation: GaExecutionConfirmation, respond: Respond) => void;

/**
 * 高危执行确认的进程内总线（票 05）：
 * GaBridgeClient 收到 409 confirmation_required 后经 request() 入队；
 * 唯一的订阅者（ExecutionConfirmDialog）逐个展示确认弹窗并回调决策。
 * 队列串行处理，弹窗只显示一个；无订阅者时请求保持挂起直到界面就绪。
 */
class ConfirmationBroker {
  private queue: Array<{ confirmation: GaExecutionConfirmation; respond: Respond }> = [];
  private active = false;
  private listener: BrokerListener | null = null;

  subscribe(listener: BrokerListener): () => void {
    this.listener = listener;
    this.pump();
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  request(confirmation: GaExecutionConfirmation): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.queue.push({ confirmation, respond: (granted) => resolve(granted) });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || !this.listener || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = true;
    this.listener(next.confirmation, (granted) => {
      next.respond(granted);
      this.active = false;
      this.pump();
    });
  }
}

export const confirmationBroker = new ConfirmationBroker();
