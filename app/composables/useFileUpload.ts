import { ref, readonly, type Ref } from 'vue'
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

export const useFileUpload = (options?: { targetUserId?: Ref<number | null | undefined> }) => {
  const tRef = options?.targetUserId
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
    if (tRef?.value) { body.targetUserId = tRef.value; body.useAdmin = 1 }
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
        if (tRef?.value) { body.targetUserId = tRef.value; body.useAdmin = 1 }
        await $fetch('/api/files/save', { method: 'POST', body })
        return config.fileKey
      }

      const cos = new COS({
        SecretId: config.credentials.TmpSecretId,
        SecretKey: config.credentials.TmpSecretKey,
        SecurityToken: config.credentials.SecurityToken,
      })

      const fileUrl = await new Promise<string>((resolve, reject) => {
        let lastLoaded = 0
        cos.putObject({
          Bucket: config.bucket,
          Region: config.region,
          Key: config.fileKey,
          Body: file,
          onProgress: (progressData: any) => {
            const loaded = progressData?.loaded ?? 0
            const total = progressData?.total ?? file.size
            const delta = Math.max(0, loaded - lastLoaded)
            lastLoaded = loaded
            options2?.onProgressDelta?.(delta)
            if (!partOfBatch) setProgress(loaded, total)
          }
        }, (err: any) => {
          if (err) {
            if (!partOfBatch) uploadError.value = err.message || '上传失败'
            reject(err)
          } else {
            const url = `https://${config.bucket}.cos.${config.region}.myqcloud.com/${config.fileKey}`
            resolve(url)
          }
        })
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
        if (tRef?.value) { body.targetUserId = tRef.value; body.useAdmin = 1 }
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
        notify(error.message || '上传失败', 'error')
        
      }
      uploadError.value = error.message || '上传失败'
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
    } catch (error: any) {
      notify(error.message || '上传失败', 'error')
      uploadError.value = error.message || '上传失败'
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