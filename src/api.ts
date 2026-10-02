/** 与后端 /api/* 的通信封装 */
import type { Bootstrap, ClassEvent, Person, PersonLink, User } from './types';

const TOKEN_KEY = 'class-atlas-token';

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? '';
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    throw new ApiError(data?.error ?? `请求失败（${res.status}）`, res.status);
  }
  return data as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { username, password },
    }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  bootstrap: () => request<Bootstrap>('/bootstrap'),

  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/auth/password', { method: 'POST', body: { oldPassword, newPassword } }),

  /* 人物 */
  createPerson: (body: Partial<Person>) => request<{ person: Person }>('/people', { method: 'POST', body }),
  updatePerson: (id: string, body: Partial<Person>) =>
    request<{ person: Person }>(`/people/${id}`, { method: 'PATCH', body }),
  deletePerson: (id: string) => request<{ ok: boolean }>(`/people/${id}`, { method: 'DELETE' }),

  /* 关系 */
  createLink: (body: Partial<PersonLink>) => request<{ link: PersonLink }>('/links', { method: 'POST', body }),
  updateLink: (id: string, body: Partial<PersonLink>) =>
    request<{ link: PersonLink }>(`/links/${id}`, { method: 'PATCH', body }),
  deleteLink: (id: string) => request<{ ok: boolean }>(`/links/${id}`, { method: 'DELETE' }),

  /* 关系类型（可自定义） */
  createLinkType: (name: string) =>
    request<{ linkTypes: string[] }>('/link-types', { method: 'POST', body: { name } }),
  renameLinkType: (from: string, name: string) =>
    request<{ linkTypes: string[]; updatedLinks: number }>(`/link-types/${encodeURIComponent(from)}`, {
      method: 'PATCH',
      body: { name },
    }),
  deleteLinkType: (name: string) =>
    request<{ linkTypes: string[]; updatedLinks: number; fallback: string }>(
      `/link-types/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  /* 事件 */
  createEvent: (body: Partial<ClassEvent>) => request<{ event: ClassEvent }>('/events', { method: 'POST', body }),
  updateEvent: (id: string, body: Partial<ClassEvent>) =>
    request<{ event: ClassEvent }>(`/events/${id}`, { method: 'PATCH', body }),
  deleteEvent: (id: string) => request<{ ok: boolean }>(`/events/${id}`, { method: 'DELETE' }),

  /* 账号（仅管理员） */
  createUser: (body: Record<string, unknown>) => request<{ user: User }>('/users', { method: 'POST', body }),
  updateUser: (id: string, body: Record<string, unknown>) =>
    request<{ user: User }>(`/users/${id}`, { method: 'PATCH', body }),
  deleteUser: (id: string) => request<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
};