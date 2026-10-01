// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: false },

  modules: ['@nuxtjs/tailwindcss'],

  app: {
    head: {
      // 站点默认标题 + 模板。页面用 useHead 设了 title 就会变成「xxx · TriCloud Drive」，
      // 没设的页面至少还有个默认标题（以前全站一个 <title> 都没有）。
      title: 'TriCloud Drive',
      titleTemplate: '%s · TriCloud Drive'
    }
  },

  css: ['~/assets/css/experimental.css'],

  nitro: {
    preset: 'node-server',
    experimental: {
      wasm: true
    },
    routeRules: {
      '/api/**': {
        cors: true,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
        }
      }
    },
    externals: {
      inline: ['jsonwebtoken', 'semver']
    },
    esbuild: {
      options: {
        target: 'es2020'
      }
    }
  },

  runtimeConfig: {
    /**
     * 会话密钥。**这里不给回退值。**
     *
     * 原来是 `process.env.SESSION_SECRET || 'fallback-secret-key'`。那个回退值
     * 是提交进仓库的公开常量，于是「部署漏配」这件事没有任何症状：不报错、
     * 不告警、照常启动 —— 只是所有人都在用一把全世界都知道的钥匙。
     * auth-token 里只有 userId，requireAuth 只验签名，所以拿到那把钥匙就能
     * 伪造任意用户的 cookie。
     *
     * 静默降级比启动失败危险得多，所以现在缺配置就是空串，由
     * server/plugins/require-session-secret.ts 在**启动时**抛。
     * 之所以不在这里抛：nuxt build 常常在没有 .env 的环境里跑（比如 CI 只做
     * 构建），那时抛会让构建凭空失败，而这个值要到运行时才被
     * NUXT_SESSION_SECRET 覆盖。
     */
    sessionSecret: process.env.SESSION_SECRET || '',
    tencentSecretId: process.env.TENCENT_SECRET_ID || '',
    tencentSecretKey: process.env.TENCENT_SECRET_KEY || '',
    cosRegion: process.env.COS_REGION || 'ap-guangzhou',
    cosBucket: process.env.COS_BUCKET || '',
    // CDN 配置
    cdnDomain: process.env.CDN_DOMAIN || '',
    cdnEnabled: process.env.CDN_ENABLED === 'true',
    /**
     * CDN 鉴权密钥。同样不回退。
     *
     * 这两个值和 sessionSecret 是同一类东西：download.post.ts 用它们给
     * `/<fileKey>?sign=...` 签名，CDN 拿它验。默认值是提交进仓库的常量，
     * 意味着漏配时任何人都能自己算出合法签名去直连 CDN 拿对象 —— 绕开
     * 本项目全部鉴权。空串同样由 require-session-secret.ts 拦下。
     */
    cdnAuthKeyPrimary: process.env.CDN_AUTH_KEY_PRIMARY || '',
    cdnAuthKeyBackup: process.env.CDN_AUTH_KEY_BACKUP || '',
    cdnAuthTtl: parseInt(process.env.CDN_AUTH_TTL || '10'), // 默认10秒
    cdnAuthParam: process.env.CDN_AUTH_PARAM || 'sign',
    dbPath: process.env.SQLITE_PATH || './data.sqlite',
    https: process.env.HTTPS === 'true',
    maxConcurrency: parseInt(process.env.COS_COPY_CONCURRENCY || '3'),
    TimeZone: process.env.TIMEZONE || '+8',
    public: {
      apiBase: '',
      allowRegister: process.env.ALLOW_REGISTER === 'true',
      TimeZone: process.env.TIMEZONE || '+8'
    }
  },
  build: {
    transpile: ['@zip.js/zip.js', 'streamsaver', '7z-wasm']
  },
  vite: {
    optimizeDeps: {
      // 重要：不要预打包 @zip.js/zip.js，避免 dev 时 esbuild 选到 Node 条件
      exclude: ['@zip.js/zip.js', '7z-wasm'],
      // 不要 include '@zip.js/zip.js'
      include: [
        '@heroicons/vue/24/outline',
        'cos-js-sdk-v5', // CJS
      ]
    }
  }/*,
  
    future: {
    compatibilityVersion: 4,
  }*/
})
