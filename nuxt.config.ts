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
    sessionSecret: process.env.SESSION_SECRET || 'fallback-secret-key',
    tencentSecretId: process.env.TENCENT_SECRET_ID || '',
    tencentSecretKey: process.env.TENCENT_SECRET_KEY || '',
    cosRegion: process.env.COS_REGION || 'ap-guangzhou',
    cosBucket: process.env.COS_BUCKET || '',
    // CDN 配置
    cdnDomain: process.env.CDN_DOMAIN || '',
    cdnEnabled: process.env.CDN_ENABLED === 'true',
    // CDN 鉴权配置
    cdnAuthKeyPrimary: process.env.CDN_AUTH_KEY_PRIMARY || 'cdn_auth_key_primary',
    cdnAuthKeyBackup: process.env.CDN_AUTH_KEY_BACKUP || 'cdn_auth_key_backup',
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
