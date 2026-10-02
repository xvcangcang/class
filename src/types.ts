/** 全局类型定义 —— 前后端共用一套数据结构 */

export type UserRole = 'admin' | 'editor' | 'viewer';
export type PersonRole = 'student' | 'teacher';

export interface Person {
  id: string;
  name: string;
  role: PersonRole;
  group: string;
  tags: string[];
  note: string;
  createdAt: number;
}

export interface PersonLink {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface ClassEvent {
  id: string;
  date: string;
  title: string;
  detail: string;
  participants: string[];
  createdBy: string;
  updatedAt: number;
}

export interface User {
  id: string;
  username: string;
  role: UserRole;
  displayName: string;
  personId: string | null;
  createdAt: number;
}

export interface RoleInfo {
  id: UserRole;
  label: string;
  desc: string;
}

export interface Bootstrap {
  me: User;
  roles: RoleInfo[];
  people: Person[];
  links: PersonLink[];
  events: ClassEvent[];
  users: User[];
  linkTypes: string[];
  version: string;
  canEdit: boolean;
  isAdmin: boolean;
}

/** 关系类型的默认值：服务端首次运行会写进 link-types.json，之后由使用者自己增删改 */
export const DEFAULT_LINK_TYPES = [
  '好友',
  '同桌',
  '同宿舍',
  '同社团',
  '小学同学',
  '班主任',
  '任教',
  '搭班',
  '其他',
];

/** 稳定配色：同一个人每次刷新颜色一致 */
const PALETTE = [
  '#38bdf8',
  '#22d3ee',
  '#34d399',
  '#a78bfa',
  '#f472b6',
  '#fbbf24',
  '#fb923c',
  '#4ade80',
  '#60a5fa',
  '#f87171',
];

export function hashCode(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function colorOf(key: string): string {
  return PALETTE[hashCode(key) % PALETTE.length];
}

export function initials(name: string): string {
  return name.slice(0, 1);
}