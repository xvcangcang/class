/** 全局类型定义 —— 前后端共用一套数据结构 */

export type UserRole = 'admin' | 'editor' | 'viewer';
export type PersonRole = 'student' | 'teacher';

export interface Person {
  id: string;
  name: string;
  role: PersonRole;
  /** 所属群组的 id 列表：一个人可以同时属于小组和宿舍 */
  groupIds: string[];
  tags: string[];
  note: string;
  createdAt: number;
}

export type GroupKind = '小组' | '宿舍' | '社团' | '其他';

export const GROUP_KINDS: GroupKind[] = ['小组', '宿舍', '社团', '其他'];

/** 群组类型 → 自动生成的人—人关系类型 */
export const GROUP_LINK_TYPE: Record<GroupKind, string> = {
  小组: '同组',
  宿舍: '同宿舍',
  社团: '同社团',
  其他: '同组',
};

/** 群组：关系图上的长方形节点，用来表达「同组 / 同宿舍」这类归属 */
export interface Group {
  id: string;
  name: string;
  kind: GroupKind;
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

/** 一条操作日志：谁 / 什么时候 / 对什么 / 做了什么 */
export interface LogEntry {
  id: string;
  /** 发生时间（毫秒时间戳） */
  ts: number;
  /** 做了什么，如「新增人物」「删除关系」 */
  action: string;
  /** 对什么做的（人名 / 群组名 / 关系两端 / 账号名） */
  target: string;
  /** 补充说明（改了哪些字段、连带影响多少条数据） */
  detail: string;
  /** 成功还是失败 */
  ok: boolean;
  /** 操作人显示名 */
  actor: string;
  /** 操作人登录名 */
  actorUsername: string;
  actorId: string | null;
  /** 来源 IP，仅在导出时查看 */
  ip: string;
}

export interface LogQueryResult {
  logs: LogEntry[];
  /** 符合筛选条件的总条数 */
  total: number;
  /** 服务器上总共存了多少条 */
  stored: number;
  /** 出现过的动作种类（用于下拉筛选） */
  actions: string[];
}

export interface Bootstrap {
  me: User;
  roles: RoleInfo[];
  people: Person[];
  groups: Group[];
  links: PersonLink[];
  events: ClassEvent[];
  users: User[];
  linkTypes: string[];
  version: string;
  canEdit: boolean;
  isAdmin: boolean;
  /** 当前这次登录是否处于无痕模式（管理员专用） */
  incognito: boolean;
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