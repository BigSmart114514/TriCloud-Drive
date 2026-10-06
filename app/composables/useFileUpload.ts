import { ref, readonly, type Ref } from 'vue'
import { withScopeRef } from '~/utils/scope'
import COS from 'cos-js-sdk-v5'

interface UploadCredentials {
  TmpSecretId: string
  TmpSecretKey: string
  SecurityToken: string
  StartTime: number
  ExpiredTime: number
}

interface UploadConfig {
  credentials: UploadCredentials
  bucket: string
  region: string
  fileKey: string
  originalFilename: string
  safeFilename: string
  uploadUrl: string
  demoMode?: boolean
  folderId?: number | null
}

interface UploadProgress {
  loaded: number
  total: number
  percent: number
}

type UploadOptions = { folderId?: number | null; overwrite?: boolean; skip?:boolean; partOfBatch?: boolean; onProgressDelta?: (delta: number) => void }

/**
 * useAdmin 显式传，不能再靠「有没有 targetUserId」推断：
 * 首页侧栏看别人的共享内容时 targetUserId 一定有值，但那不是管理视角，
 * 顺手带上 useAdmin=1 会被服务端 403（useAdmin=true 仅管理员）。
 */
export const useFileUpload = (options?: {
  targetUserId?: Ref<number | null | undefined>
  useAdmin?: Ref<boolean | null | undefined>
}) => {
  const tRef = options?.targetUserId
  const useAdmin = options?.useAdmin
  const uploading = ref(false)
  const uploadProgress = ref<UploadProgress>({ loaded: 0, total: 0, percent: 0 })
  const uploadError = ref('')

  const setProgress = (loaded: number, total: number) => {
    const percent = total > 0 ? Math.round((loaded / total) * 100) : (loaded > 0 ? 100 : 0)
    uploadProgress.value = { loaded, total, percent }
  }

  const getUploadCredentials = async (params: {
    filename: string
    fileSize: number
    folderId?: number | null
    overwrite?: boolean
    skip?: boolean
  }): Promise<UploadConfig> => {
    const body: any = {
      filename: params.filename,
      fileSize: params.fileSize,
      folderId: params.folderId ?? null,
      overwrite: !!params.overwrite,
      skipIfExist: !!params.skip
    }
    withScopeRef(body, tRef, useAdmin)
    const response = await $fetch<{ success: boolean; data: UploadConfig }>('/api/upload/credentials', {
      method: 'POST',
      body
    })
    if (!response.success) 
    {
      throw new Error('获取上传凭证失败')
    }
    return response.data
  }

  const uploadFile = async (file: File, options2?: UploadOptions): Promise<string> => {
    const partOfBatch = !!options2?.partOfBatch
    const folderId = options2?.folderId ?? null
    const overwrite = !!options2?.overwrite
    const skip = !!options2?.skip

    try {
      if (!partOfBatch) { uploading.value = true; uploadError.value = ''; setProgress(0, file.size) }

      const config = await getUploadCredentials({ filename: file.name, fileSize: file.size, folderId, overwrite, skip })

      if (config.demoMode) {
        let lastLoaded = 0
        for (let i = 0; i <= 100; i += 10) {
          const loaded = Math.round((file.size * i) / 100)
          const delta = Math.max(0, loaded - lastLoaded)
          lastLoaded = loaded
          options2?.onProgressDelta?.(delta)
          if (!partOfBatch) setProgress(loaded, file.size)
          await new Promise(r => setTimeout(r, 100))
        }
        const fileUrl = `${config.uploadUrl}/${config.fileKey}`
        const body: any = {
          filename: file.name,
          safeFilename: config.safeFilename,
          fileKey: config.fileKey,
          fileSize: file.size,
          fileUrl,
          contentType: file.type,
          folderId,
          overwrite
        }
        withScopeRef(body, tRef, useAdmin)
        await $fetch('/api/files/save', { method: 'POST', body })
        return config.fileKey
      }

      const cos = new COS({
        SecretId: config.credentials.TmpSecretId,
        SecretKey: config.credentials.TmpSecretKey,
        SecurityToken: config.credentials.SecurityToken,
      })

      /**
       * 单发 vs 分片。
       *
       * 原来**一律** putObject：整个文件一个 XHR。三个后果：
       *   1. 传大文件时单个请求要挂很久。中途网络抖动 / COS 侧 5xx 就整份重传，
       *      而且 cos-js-sdk-v5 的 putObject 回调只在整体结束时才 reject ——
       *      中途失败没有「从第几字节续传」的概念。
       *   2. 单请求窗口越长，越容易撞上 `net::ERR_UPLOAD_FILE_CHANGED`：
       *      Chrome 发现文件在传输途中被改过（拖拽路径上传的是浏览器造的沙箱
       *      副本，它与原文件是两套时间戳）就掐断。
       *   3. 一个失败等于一个巨大请求白费。
       *
       * sliceUploadFile 解决 1/3 并把窗口切小。它需要 STS 策略里有分块相关的
       * action —— credentials.post.ts 里那七条（InitiateMultipartUpload /
       * ListParts / UploadPart / CompleteMultipartUpload 等）本来就在，只是
       * 一直用不上。
       *
       * 阈值取 8MB：小于它分片的额外往返（Initiate + N×UploadPart +
       * Complete）不划算，大于它单发的风险明显。
       */
      const CHUNK_THRESHOLD = 8 * 1024 * 1024
      const useChunks = file.size > CHUNK_THRESHOLD

      const fileUrl = await new Promise<string>((resolve, reject) => {
        let lastLoaded = 0
        const onProgress = (progressData: any) => {
          const loaded = progressData?.loaded ?? 0
          const total = progressData?.total ?? file.size
          const delta = Math.max(0, loaded - lastLoaded)
          lastLoaded = loaded
          options2?.onProgressDelta?.(delta)
          if (!partOfBatch) setProgress(loaded, total)
        }
        const onDone = (err: any) => {
          if (err) {
            if (!partOfBatch) uploadError.value = err.message || '上传失败'
            reject(err)
          } else {
            const url = `https://${config.bucket}.cos.${config.region}.myqcloud.com/${config.fileKey}`
            resolve(url)
          }
        }

        if (useChunks) {
          cos.sliceUploadFile({
            Bucket: config.bucket,
            Region: config.region,
            Key: config.fileKey,
            Body: file,
            // 4MB 一片：COS 最低要求 1MB，取 4MB 让请求数不至于太多。
            // 注意分块大小与分块数都参与签名，改这里要连带看 policies。
            // 字段名是 ChunkSize 而不是 SliceSize —— 后者是 uploadFiles 的参数名，
            // 写错的话 TS 会报「未知属性」（它确实报了）。
            ChunkSize: 4 * 1024 * 1024,
            onProgress
          }, onDone)
          return
        }

        cos.putObject({
          Bucket: config.bucket,
          Region: config.region,
          Key: config.fileKey,
          Body: file,
          onProgress
        }, onDone)
      })

      {
        const body: any = {
          filename: file.name,
          safeFilename: config.safeFilename,
          fileKey: config.fileKey,
          fileSize: file.size,
          fileUrl,
          contentType: file.type,
          folderId,
          overwrite
        }
        withScopeRef(body, tRef, useAdmin)
        await $fetch('/api/files/save', { method: 'POST', body })
      }
      //console.log(fileUrl)
      return config.fileKey
    } catch (error: any) {
      /*
      if (skip === true)
      {
        notify(file.name + '已跳过','success')
      }*/
     
      if (!partOfBatch) 
      {
        notifyError(error, '上传失败')
        
      }
      uploadError.value = toMessage(error, '上传失败')
      throw error
    } finally {
      if (!partOfBatch) uploading.value = false
    }
  }

  const uploadMultipleFiles = async (files: File[], options3?: { folderId?: number | null; overwrite?: boolean; skip?: boolean }): Promise<undefined> => {
    const folderId = options3?.folderId ?? null
    const overwrite = !!options3?.overwrite
    const skip = !!options3?.skip

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    let aggregatedLoaded = 0

    uploading.value = true
    uploadError.value = ''
    setProgress(0, totalBytes)

    try {
      for (const file of files) {
        const url = await uploadFile(file, {
          folderId,
          overwrite,
          skip,
          partOfBatch: true,
          onProgressDelta: (delta: number) => {
            aggregatedLoaded += delta
            setProgress(aggregatedLoaded, totalBytes)
          }
        })
      }
      setProgress(totalBytes, totalBytes)
      return
    } catch (error) {
      // 这里**不弹 toast**：本函数只跑在 useDnDUpload 的 handleFiles / handleEntries
      // 里面，那才是这条链的终点，由它弹。
      //
      // 原来两层都调 notifyError，于是同一个 error 对象被提示两次、屏幕上出现
      // 两句一模一样的话（403 自带 message，notifyError 的 fallback 不生效，
      // 所以两遍显示的都是服务端原文，例如「存储空间不足，上传该文件将超出配额」）。
      //
      // uploadError.value 仍然要设：那是 FileBrowser 里的红条横幅，
      // 与 toast 是两回事，重复赋同一个值看不出问题。
      uploadError.value = toMessage(error, '上传失败')
      throw error

    } finally {
      uploading.value = false
    }
  }

  return {
    uploading: readonly(uploading),
    uploadProgress: readonly(uploadProgress),
    uploadError: readonly(uploadError),
    uploadFile,
    uploadMultipleFiles
  }
}