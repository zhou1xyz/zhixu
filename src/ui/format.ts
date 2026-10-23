/**
 * format.ts —— 界面层共用的格式化工具
 *
 * 为什么单独抽一个文件：日期格式（MM-DD HH:mm）和状态中文名以前在三个组件里
 * 各写了一份，改格式要改三处，迟早漏改一处。集中到这里，只有一个来源。
 */

/** 状态码对应的中文名 */
export const STATUS_LABELS: Record<string, string> = {
  todo: '待处理',
  waiting: '等待中',
  done: '已完成',
};

/** 把 ISO 时间显示成 10-22 09:30；解析失败时原样返回，不吞掉异常数据 */
export function formatStamp(iso: string): string {
  const d: Date = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
