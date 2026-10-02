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
 * 首次运行种子数据 —— 保证一部署就能看到一张像样的图
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

  if (!existsSync(fileOf('people'))) {
    const now = Date.now();
    const people = [
      ['王老师', 'teacher', '教师办公室', ['班主任', '数学']],
      ['李老师', 'teacher', '教师办公室', ['语文']],
      ['张老师', 'teacher', '教师办公室', ['英语']],
      ['同学A', 'student', '第一组', ['班长']],
      ['同学B', 'student', '第一组', ['体育委员']],
      ['同学C', 'student', '第二组', []],
      ['同学D', 'student', '第二组', ['学习委员']],
      ['同学E', 'student', '第三组', []],
      ['同学F', 'student', '第三组', ['文艺委员']],
      ['同学G', 'student', '第四组', []],
      ['同学H', 'student', '第四组', []],
    ].map(([name, role, group, tags]) => ({
      id: randomUUID(),
      name,
      role,
      group,
      tags,
      note: '',
      createdAt: now,
    }));
    savePeople(people);

    const by = (name) => people.find((p) => p.name === name)?.id;
    const link = (source, target, type, weight) => ({
      id: randomUUID(),
      source: by(source),
      target: by(target),
      type,
      weight,
    });
    saveLinks([
      link('王老师', '同学A', '班主任', 3),
      link('王老师', '同学B', '班主任', 3),
      link('王老师', '同学C', '班主任', 3),
      link('李老师', '同学D', '任教', 2),
      link('李老师', '同学E', '任教', 2),
      link('张老师', '同学F', '任教', 2),
      link('张老师', '同学G', '任教', 2),
      link('同学A', '同学B', '好友', 3),
      link('同学A', '同学C', '同桌', 2),
      link('同学A', '同学D', '好友', 2),
      link('同学B', '同学D', '好友', 2),
      link('同学C', '同学E', '同宿舍', 3),
      link('同学D', '同学F', '同桌', 2),
      link('同学E', '同学F', '好友', 2),
      link('同学G', '同学H', '同桌', 2),
      link('同学F', '同学H', '同社团', 1),
    ]);

    const pid = (name) => (by(name) ? [by(name)] : []);
    saveEvents([
      {
        id: randomUUID(),
        date: '2026-09-01',
        title: '开学报到',
        detail: '全班第一次见面，分配座位与宿舍。',
        participants: [...pid('同学A'), ...pid('同学B'), ...pid('王老师')],
        createdBy: 'system',
        updatedAt: now,
      },
      {
        id: randomUUID(),
        date: '2026-09-28',
        title: '秋季运动会',
        detail: '同学B 拿了 800 米第二名。',
        participants: [...pid('同学B'), ...pid('同学A')],
        createdBy: 'system',
        updatedAt: now,
      },
      {
        id: randomUUID(),
        date: '2026-10-01',
        title: '第一次月考',
        detail: '全班参加，之后按成绩调整小组。',
        participants: people.filter((p) => p.role === 'student').map((p) => p.id),
        createdBy: 'system',
        updatedAt: now,
      },
    ]);
  }
}
