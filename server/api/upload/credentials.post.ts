import { getMeAndTarget } from '~~/server/utils/auth-middleware'
import { getDb } from '~~/server/utils/db-adapter'
import crypto from 'crypto'
import { UserService, FileService, FolderService } from '~~/server/utils/db'
import { PERM_WRITE } from '~~/types/share'
import { isExpired } from '~~/server/utils/time'

export default defineEventHandler(async (event) => {
  // 处理 CORS 预检
  if (getMethod(event) === 'OPTIONS') {
    setHeaders(event, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
    })
    return ''
  }
  // CORS
  setHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
  })

  // parseSqlDateTime / isExpired 都搬到 server/utils/time.ts 了（原来在这
  // 和 save.post.ts 各抄一份，都用本地时区方法，与 DB 的 UTC 存法不同源）。
  function normalizeFolderId(input: any): number | null {
    if (input === undefined || input === null || input === '' || input === 'root' || input === '0' || input === 0) {
      return null
    }
    const n = Number(input)
    if (!Number.isInteger(n) || n < 1) {
      throw createError({ statusCode: 400, message: '非法的 folderId' })
    }
    return n
  }

  try {
    const { authUserId } = await getMeAndTarget(event)
    const authId = Number(authUserId)
    const config = useRuntimeConfig()
    const db = getDb(event)
    

    if (!db) {
      throw createError({ statusCode: 500, message: '数据库连接失败' })
    }
    const userService = new UserService(db)
    const fileService = new FileService(db)
    const folderService = new FolderService(db)

    const body = await readBody(event)
    const { filename, fileSize, overwrite, skipIfExist } = body
    const folderId = normalizeFolderId(body?.folderId)


    if (overwrite === true && skipIfExist === true)
    {
      throw createError({ statusCode: 400, message: '不能既覆盖又跳过文件'})
    }

    if (!filename) {
      throw createError({ statusCode: 400, message: '文件名不能为空' })
    }

    const size = Number(fileSize)
    if (!Number.isFinite(size) || size < 0) {
      throw createError({ statusCode: 400, message: 'fileSize 参数无效' })
    }

    /**
     * 目标目录必须对我有 write。
     *
     * 这一段是补的：原来这里只 `getUserById(targetUserId)` 查了**目标用户**的
     * 账号状态就直接发 STS 临时凭证，完全没问「我有没有权限往那儿传」。
     * 任何登录用户传 targetUserId=<属主> 就能拿到对方的腾讯云临时凭证，
     * 往对方桶里写文件。
     *
     * 凭证归属与配额按属主：文件落在谁的树里就用谁的 bucket 路径、占谁的容量。
     */
    let userId = authId
    if (folderId !== null) {
      const dest = await folderService.findAccessibleById(authId, folderId, PERM_WRITE)
      userId = dest.userId
    }

    const user = await userService.getUserById(userId)
    if (!user)
    {
      throw createError({ statusCode: 404, message: '用户不存在或已被删除' })
    }
    if (isExpired(user.expire_at)) {
      throw createError({ statusCode: 403, message: '账号已过期，禁止上传' })
    }

    const usedStorage = Number(user.usedStorage ?? 0) || 0
    const maxStorage = Number(user.maxStorage ?? 0) || 0

    // 若选择覆盖且存在同名文件，则抵扣旧文件大小
    let usedForCheck = usedStorage
    if (overwrite === true || skipIfExist === true) {
      const row = await fileService.findByName(user.id, folderId, filename)
      if (row && overwrite === true) {
        usedForCheck = Math.max(0, usedStorage - row.fileSize)
      } else if (row && skipIfExist === true) {
        return { success: false, statusMessage: '当前目录下已存在该文件' }
      }
    }

    if (maxStorage > 0 && usedForCheck + size > maxStorage) {
      throw createError({ statusCode: 403, message: '存储空间不足，上传该文件将超出配额' })
    }

    // 目标目录归属校验（放在配额判断之后，与原逻辑保持一致）
    await fileService.assertFolderOwned(user.id, folderId)

    // 生成用于对象存储的 key（与文件夹逻辑解耦，文件夹信息仅存 DB）
    const uuid = crypto.randomUUID()
    const fileExtension = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')).toLowerCase() : ''
    const now = new Date()
    // 用 UTC 而不是本地：服务器时区不是 UTC 时，月末/年末边界会把文件分到
    // 相邻的月份桶里（本地 1/1 凌晨 = UTC 前一天），同一批文件散到两个目录。
    // 注意这只影响**新**文件，已有对象的路径不变（路径里本来就带 uuid，
    // 不会撞车），也不会去动 COS 上的存量数据。
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    const safeFilename = `${uuid}${fileExtension}`
    const fileKey = `users/${user.id}/${year}${month}/${safeFilename}`

    // 检查 COS 密钥
    if (!config.tencentSecretId || !config.tencentSecretKey ) {
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, statusMessage: '腾讯云密钥未配置' })
      }
    }

    // 生成 STS 临时密钥
    const mod = await import('tencentcloud-sdk-nodejs/tencentcloud/services/sts/v20180813/sts_client.js')
    const Client = (mod.default?.Client) || mod.Client
    const client = new Client({
    credential: { secretId: config.tencentSecretId, secretKey: config.tencentSecretKey },
    region: config.cosRegion,
    })

    const appId = config.cosBucket.substr(config.cosBucket.lastIndexOf('-') + 1)
    const resource = `qcs::cos:${config.cosRegion}:uid/${appId}:${config.cosBucket}/${fileKey}`

    const params = {
      Policy: JSON.stringify({
        version: '2.0',
        statement: [
          {
            effect: 'allow',
            action: [
              'name/cos:PutObject',
              'name/cos:PostObject',
              'name/cos:InitiateMultipartUpload',
              'name/cos:ListMultipartUploads',
              'name/cos:ListParts',
              'name/cos:UploadPart',
              'name/cos:CompleteMultipartUpload'
            ],
            resource: [resource]
          }
        ]
      }),
      DurationSeconds: config.cdnAuthTtl,
      Name: `cos-upload-${user.id}-${Date.now()}`
    }

    const response = await client.GetFederationToken(params)
    const credentials = response.Credentials
    if (!credentials) {
      throw createError({ statusCode: 500, message: '获取临时密钥失败' })
    }

    return {
      success: true,
      data: {
        credentials: {
          TmpSecretId: credentials.TmpSecretId,
          TmpSecretKey: credentials.TmpSecretKey,
          SecurityToken: credentials.Token,
          StartTime: Math.floor(Date.now() / 1000),
          ExpiredTime: Math.floor(Date.now() / 1000) + config.cdnAuthTtl
        },
        bucket: config.cosBucket,
        region: config.cosRegion,
        fileKey,
        folderId,                 // 回传当前目录
        originalFilename: filename,
        safeFilename,
        uploadUrl: `https://${config.cosBucket}.cos.${config.cosRegion}.myqcloud.com`
      }
    }
  } catch (error: any) {
    console.error('Generate upload credentials error:', error)
    if (error.statusCode) throw error
    throw createError({ statusCode: 500, message: '生成上传凭证失败' })
  }
})