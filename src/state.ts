/** 全局状态：登录用户 + 全部业务数据 */
import type { Bootstrap } from './types';

let current: Bootstrap | null = null;

export function setData(next: Bootstrap): void {
  current = next;
}

export function getData(): Bootstrap {
  if (!current) throw new Error('数据还没加载');
  return current;
}

export function hasData(): boolean {
  return current !== null;
}

export function clearData(): void {
  current = null;
}
