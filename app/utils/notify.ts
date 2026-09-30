// utils/notify.ts
export type NotifyState = 'success' | 'error';

let containerEl: HTMLElement | null = null;
let styleInjected = false;

const isClient = () => typeof window !== 'undefined' && typeof document !== 'undefined';

function injectStyleOnce() {
  if (!isClient() || styleInjected) return;
  const style = document.createElement('style');
  style.id = 'nuxt-notify-style';
  style.textContent = `
  .nuxt-notify-container {
    position: fixed;
    top: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    z-index: 9999;
    pointer-events: none;
  }
  .nuxt-notify-toast {
    pointer-events: auto;
    min-width: 240px;
    max-width: 380px;
    background: var(--notify-bg, #111827);
    color: var(--notify-fg, #F9FAFB);
    border-left: 4px solid transparent;
    border-radius: 10px;
    box-shadow: 0 10px 20px rgba(0,0,0,.2), 0 6px 6px rgba(0,0,0,.1);
    padding: 12px 14px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    transform: translateX(120%);
    opacity: 0;
    will-change: transform, opacity;
  }
  .nuxt-notify-toast.success { border-left-color: #10B981; }
  .nuxt-notify-toast.error   { border-left-color: #EF4444; }

  @media (prefers-color-scheme: light) {
    .nuxt-notify-toast {
      --notify-bg: #FFFFFF;
      --notify-fg: #111827;
      box-shadow: 0 8px 24px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.06);
    }
  }

  .nuxt-notify-toast.show {
    animation: nuxt-notify-in 240ms cubic-bezier(.2,.7,.3,1) forwards;
  }
  .nuxt-notify-toast.hide {
    animation: nuxt-notify-out 200ms cubic-bezier(.2,.7,.3,1) forwards;
  }
  @keyframes nuxt-notify-in {
    from { transform: translateX(120%); opacity: 0; }
    to   { transform: translateX(0); opacity: 1; }
  }
  @keyframes nuxt-notify-out {
    from { transform: translateX(0); opacity: 1; }
    to   { transform: translateX(120%); opacity: 0; }
  }

  .nuxt-notify-icon {
    line-height: 1;
    font-size: 16px;
    margin-top: 2px;
  }
  .nuxt-notify-message {
    white-space: pre-wrap;
    line-height: 1.35;
    word-break: break-word;
    flex: 1;
  }

  html[data-ui='experimental'] .nuxt-notify-toast {
    background: rgba(255, 255, 255, 0.72);
    color: #0F172A;
    border: 1px solid rgba(255, 255, 255, 0.7);
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.18);
    backdrop-filter: blur(18px) saturate(180%);
    -webkit-backdrop-filter: blur(18px) saturate(180%);
  }
  `;
  document.head.appendChild(style);
  styleInjected = true;
}

function ensureContainer(): HTMLElement | null {
  if (!isClient()) return null;
  if (containerEl && document.body.contains(containerEl)) return containerEl;
  containerEl = document.createElement('div');
  containerEl.className = 'nuxt-notify-container';
  document.body.appendChild(containerEl);
  return containerEl;
}

function escapeHtml(str: string) {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m] as string));
}

/**
 * 从 $fetch / FetchError 里取出服务端给的中文提示。
 *
 * ofetch 抛出的 e.message 形如 "[POST] http://host/api/x 403"，对用户没有意义，
 * 所以优先取 h3 错误体里的 statusMessage，噪音一律丢掉换成 fallback。
 * 注意 h3 的错误体是 { error, url, statusCode, statusMessage, message, stack }，
 * statusMessage 和 message 都在且通常同值；statusMessage 优先，message 兜底
 * （有些内部错误只填 message）。
 */
export function toMessage(e: any, fallback = '操作失败'): string {
  const fromBody = [
    e?.data?.statusMessage,
    e?.statusMessage,
    e?.response?._data?.statusMessage,
    e?.data?.message,
    e?.response?._data?.message
  ]
  for (const c of fromBody) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  const raw = typeof e?.message === 'string' ? e.message.trim() : ''
  if (raw && !/^\[[A-Z]+\]\s/.test(raw) && !/^HTTP\s*\d{3}/i.test(raw)) return raw
  return fallback
}

/** catch 块里的标准写法：把任意异常变成一条错误通知 */
export function notifyError(e: any, fallback = '操作失败') {
  notify(toMessage(e, fallback), 'error')
}

/**
 * 右上角通知
 * @param message 文本内容
 * @param state 'success' | 'error'
 */
export function notify(message: string, state: NotifyState) {
  if (!isClient()) return; // SSR 安全 no-op

  injectStyleOnce();
  const root = ensureContainer();
  if (!root) return;

  const toast = document.createElement('div');
  toast.className = `nuxt-notify-toast ${state}`;
  toast.setAttribute('role', state === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');

  const icon = state === 'success' ? '✓' : '⚠️';
  toast.innerHTML = `
    <span class="nuxt-notify-icon">${icon}</span>
    <div class="nuxt-notify-message">${escapeHtml(message)}</div>
  `;

  root.appendChild(toast);

  // 触发入场动画
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // 停留时长（根据文本长度略微调整）
  const duration = Math.max(1800, Math.min(8000, 3000 + message.length * 25));

  const removeToast = () => {
    toast.classList.remove('show');
    toast.classList.add('hide');
    toast.addEventListener(
      'animationend',
      () => {
        toast.remove();
        if (root.childElementCount === 0) {
          root.remove();
          containerEl = null;
        }
      },
      { once: true }
    );
  };

  const timer = setTimeout(removeToast, duration);

  // 点击立即关闭
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    removeToast();
  });
}