/** 登录页 */
import { api, setToken } from '../api';
import { h } from '../ui';

export function renderLogin(root: HTMLElement, onSuccess: () => Promise<void> | void): void {
  const username = h('input', {
    class: 'input',
    placeholder: '用户名',
    autocomplete: 'username',
  }) as HTMLInputElement;
  const password = h('input', {
    class: 'input',
    type: 'password',
    placeholder: '密码',
    autocomplete: 'current-password',
  }) as HTMLInputElement;
  const error = h('div', { class: 'muted', style: 'color:var(--danger);min-height:18px;margin-bottom:8px' });
  const submit = h(
    'button',
    { class: 'btn btn-primary btn-block', type: 'submit' },
    '登录',
  ) as HTMLButtonElement;

  const form = h(
    'form',
    {
      onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          const res = await api.login(username.value.trim(), password.value);
          setToken(res.token);
          await onSuccess();
        } catch (err) {
          error.textContent = (err as Error).message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { text: '用户名' }), username),
    h('div', { class: 'field' }, h('label', { text: '密码' }), password),
    error,
    submit,
  );

  root.append(
    h(
      'div',
      { class: 'login-wrap' },
      h(
        'div',
        { class: 'login-card' },
        h('h1', { text: 'Class Analysis Platform' }),
        h(
          'div',
          { class: 'sub' },
          '把班上的人和关系，画成一张一眼就懂的图。',
          h('br'),
          '登录后才能查看；每个人按自己的权限，能看 / 能改的东西不一样。',
        ),
        form,
      ),
    ),
  );
  username.focus();
}