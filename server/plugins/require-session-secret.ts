/**
 * 启动时校验密钥类配置，缺失/过弱就**拒绝启动**。
 *
 * ## 为什么单独一个插件
 *
 * 因为这些值原先在 nuxt.config.ts 里都有回退常量（'fallback-secret-key'、
 * 'cdn_auth_key_primary'），而回退的效果是：部署漏配 → 不报错、不告警、
 * 照常启动 → 所有人都在用一把全世界都知道的钥匙。
 *
 * 静默降级在这里比启动失败危险得多，所以改成 fail fast。
 * 不在 nuxt.config.ts 里抛是因为构建期常常没有 .env（CI 只做 build），
 * 那个值要到运行时才被 NUXT_* 环境变量覆盖 —— 在配置解析阶段抛会让构建
 * 凭空失败，而构建本身并不需要这个密钥。
 *
 * ## 拦哪几个
 *
 * - sessionSecret：JWT 签名密钥。auth-token 里只有 userId，requireAuth 只验
 *   签名。泄漏 = 伪造任意用户（含超管）的 cookie，直接接管系统。
 * - cdnAuthKeyPrimary / cdnAuthKeyBackup：download.post.ts 用它们给
 *   `/<fileKey>?sign=...` 签名，CDN 拿它验。泄漏 = 自己算签名直连 CDN 取
 *   对象，绕开本项目全部鉴权。只在 cdnEnabled 时要求。
 *
 * ## 弱密钥判定
 *
 * 除了「没配」，还拦两种实际踩过的：
 *   1. 太短（< 16 字符）—— HS256 的密钥空间
 *   2. 就是 .env.example / 文档里的占位符字面量
 *      （a_secure_random_string_for_sessions、your_secure_random_string_here…）
 *      这些字面量是公开的，且极易被「照着示例填」原样留下。
 */
import { getDb } from '~~/server/utils/db-adapter'

/** 文档/示例里出现过的占位符。命中即视为没配 —— 它们本身就是公开的。 */
const PLACEHOLDER_SECRETS = [
  'a_secure_random_string_for_sessions',
  'your_secure_random_string_here',
  'fallback-secret-key',
  'your_secret_id_here',
  'your_secret_key_here',
  'cdn_auth_key_primary',
  'cdn_auth_key_backup',
  'your-cdn-auth-key-primary',
  'your-cdn-auth-key-backup'
]

/** 短于此长度的一律拒绝。16 是下限，不是目标值。 */
const MIN_SECRET_LENGTH = 16

function reject(reason: string, key: string, envName: string): never {
  throw new Error(
    `[config] ${key} 不可用：${reason}\n` +
      `  这会让服务带着一把可预测的密钥跑起来 —— 任何拿到源码的人都能伪造身份或伪造 CDN 签名。\n` +
      `  请在 .env 里设置 ${envName}=<随机值>（openssl rand -hex 32 可生成）。`
  )
}

function checkSecret(value: unknown, key: string, envName: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    reject('未配置', key, envName)
  }
  const v = value as string
  if (PLACEHOLDER_SECRETS.includes(v)) {
    reject('还是示例/文档里的占位符字面量（这个值是公开的）', key, envName)
  }
  if (v.length < MIN_SECRET_LENGTH) {
    reject(`只有 ${v.length} 个字符，至少需要 ${MIN_SECRET_LENGTH}`, key, envName)
  }
}

export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()

  checkSecret(config.sessionSecret, 'sessionSecret', 'NUXT_SESSION_SECRET')

  // CDN 签名只在启用 CDN 时才用得到，没开 CDN 就没必要为它拦住启动
  if (config.cdnEnabled) {
    checkSecret(config.cdnAuthKeyPrimary, 'cdnAuthKeyPrimary', 'NUXT_CDN_AUTH_KEY_PRIMARY')
    checkSecret(config.cdnAuthKeyBackup, 'cdnAuthKeyBackup', 'NUXT_CDN_AUTH_KEY_BACKUP')
  }

  // 腾讯云密钥：只在真正要上传/下载时才用到。这里只告警不拦 ——
  // demoMode 下的本地部署没有云存储也能跑，拦了会打断既有的开发流程。
  if (config.cdnEnabled && !config.cdnDomain) {
    console.warn('[config] cdnEnabled=true 但 cdnDomain 为空，下载会走 COS 直链')
  }
  if (!config.tencentSecretId || !config.tencentSecretKey) {
    console.warn('[config] 腾讯云密钥未配置，上传/复制会失败（demoMode 下仅模拟）')
  }

  // 数据库：完全没有可用连接时给出明确提示，而不是让每个请求各自 500。
  // 这里刻意不抛 —— db-adapter 有多处按需初始化，插件阶段拿不到不代表运行时
  // 拿不到（迁移插件也是这个取舍）。
  try {
    if (!getDb({ context: {} } as any)) {
      console.warn('[config] 数据库未就绪，请检查 SQLITE_PATH / DATABASE_URL')
    }
  } catch {
    // 同上：拿不到不等于不可用
  }
})
