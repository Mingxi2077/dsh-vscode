/**
 * 全局任务互斥：聊天面板主任务/后台任务、@dsh-agent 参与者任务共享“忙”租约。
 * 用 owner 名区分来源，旧面板 dispose 不会误清掉参与者的租约。
 */

const activeOwners = new Set<string>();

export type TaskOwner = "panel" | "participant" | "plugin" | "selftest" | "envcheck" | "watch";

/** 是否有任一 DSH 任务正在运行。 */
export function isAnyTaskActive(): boolean {
  return activeOwners.size > 0;
}

/** 持有/释放一个任务租约。 */
export function setTaskActive(owner: TaskOwner, active: boolean): void {
  if (active) activeOwners.add(owner);
  else activeOwners.delete(owner);
}
