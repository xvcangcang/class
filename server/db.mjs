/**
 * 班级图谱 · 数据层
 *
 * 零依赖：只用 Node 内置模块。数据以 JSON 文件形式落在 DATA_DIR。
 *  - 线上：PocketBay 会挂载持久卷并注入 POCKETBAY_DATA_DIR=/data，跨版本保留。
 *  - 本地：落在项目内 ./data。
 *
 * 单文件、同步读写。班级规模（几十号人）完全够用，也最容易看懂。
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const DATA_DIR = process.env.POCKETBAY_DATA_DIR || join(ROOT, 'data');

const FILES = {
  users: 'users.json',
  people: 'people.json',
  links: 'links.json',
  events: 'events.json',
  sessions: 'sessions.json',
};

/* ------------------------------------------------------------------ *
 * 基础读写（原子写：先写 .tmp 再 rename，避免写一半文件损坏）
 * ------------------------------------------------------------------ */
function fileOf(name) {
  return join(DATA_DIR, FILES[name] ?? name);
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(fileOf(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = fileOf(name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

/* ------------------------------------------------------------------ *
 * 密码：scrypt 加盐哈希，绝不存明文
 * ------------------------------------------------------------------ */
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const derived = scryptSync(String(password), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return derived.length === known.length && timingSafeEqual(derived, known);
}

/* ------------------------------------------------------------------ *
 * 权限：admin > editor > viewer
 * ------------------------------------------------------------------ */
export const ROLES = ['admin', 'editor', 'viewer'];
export const ROLE_LABELS = { admin: '管理员', editor: '编辑者', viewer: '只读' };
export const ROLE_DESC = {
  admin: '可管理账号、编辑全部内容',
  editor: '可编辑人物 / 关系 / 事件',
  viewer: '只能查看，不能修改',
};

export const isAdmin = (user) => user?.role === 'admin';
export const canEdit = (user) => user?.role === 'admin' || user?.role === 'editor';

/* ------------------------------------------------------------------ *
 * 会话（登录令牌）
 * ------------------------------------------------------------------ */
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 天

export function createSession(userId) {
  const sessions = readJson('sessions', {});
  const token = randomBytes(24).toString('hex');
  const now = Date.now();
  sessions[token] = { userId, createdAt: now, expiresAt: now + SESSION_TTL };
  for (const [key, value] of Object.entries(sessions)) {
    if (!value || value.expiresAt < now) delete sessions[key];
  }
  writeJson('sessions', sessions);
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const sessions = readJson('sessions', {});
  const session = sessions[token];
  if (!session || session.expiresAt < Date.now()) return null;
  const users = readJson('users', []);
  return users.find((u) => u.id === session.userId) ?? null;
}

export function destroySession(token) {
  if (!token) return;
  const sessions = readJson('sessions', {});
  if (token in sessions) {
    delete sessions[token];
    writeJson('sessions', sessions);
  }
}

/* ------------------------------------------------------------------ *
 * 集合读写
 * ------------------------------------------------------------------ */
export const getUsers = () => readJson('users', []);
export const saveUsers = (list) => writeJson('users', list);
export const getPeople = () => readJson('people', []);
export const savePeople = (list) => writeJson('people', list);
export const getLinks = () => readJson('links', []);
export const saveLinks = (list) => writeJson('links', list);
export const getEvents = () => readJson('events', []);
export const saveEvents = (list) => writeJson('events', list);

/** 对外输出用户信息时抹掉密码哈希 */
export function publicUser(user) {
  if (!user) return null;
  const clone = { ...user };
  delete clone.password;
  return clone;
}

/* ------------------------------------------------------------------ *
 * 首次运行初始化
 *
 * 只创建默认管理员账号；人物 / 关系 / 事件一律留空，由使用者在界面里自己录入。
 * 注意：本函数只在文件「不存在」时创建，所以要让已部署的实例也清空，
 * 得删掉数据目录下的 people.json / links.json / events.json，或走接口删。
 * ------------------------------------------------------------------ */
export function ensureSeed() {
  mkdirSync(DATA_DIR, { recursive: true });

  if (!existsSync(fileOf('users'))) {
    saveUsers([
      {
        id: randomUUID(),
        username: 'admin',
        password: hashPassword('admin123'),
        role: 'admin',
        displayName: '管理员',
        personId: null,
        createdAt: Date.now(),
      },
    ]);
  }

  if (!existsSync(fileOf('people'))) writeJson('people', []);
  if (!existsSync(fileOf('links'))) writeJson('links', []);
  if (!existsSync(fileOf('events'))) writeJson('events', []);

  clearLegacyDemoData();
}

/**
 * v0.1.0 曾在首次运行时预置 11 个示例人物、16 条关系和 3 条事件。
 * 这里做一次性清理（用标记文件保证只执行一次），
 * 之后 people / links / events 只会是使用者自己录入的数据。
 */
const LEGACY_DEMO_NAMES = [
  '王老师',
  '李老师',
  '张老师',
  '同学A',
  '同学B',
  '同学C',
  '同学D',
  '同学E',
  '同学F',
  '同学G',
  '同学H',
];

function clearLegacyDemoData() {
  const flag = join(DATA_DIR, '.cleared-legacy-demo');
  if (existsSync(flag)) return;
  const people = getPeople();
  if (people.some((p) => LEGACY_DEMO_NAMES.includes(p.name))) {
    writeJson('people', []);
    writeJson('links', []);
    writeJson('events', []);
    console.log('已清除旧版预置的示例人物与事件');
  }
  writeFileSync(flag, new Date().toISOString());
}
