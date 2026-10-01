export const CopyService = {
  /**
   * `link` 走 query：分享链接的匿名放行由中间件判定，中间件只读 query、
   * 不碰 body（body 在 handler 里还要再读一遍）。
   *
   * 带 link 时服务端换掉**源**的解析方式（按 token 查边界），目标目录判定不变
   * —— 链接只授权「读源」，绝不授权写进属主的树。
   * 仍然要求登录：复制是写操作，得有个身份来承担空间额度。
   */
  async paste(
    targetFolderId: number | null,
    folderIds: number[],
    fileIds: number[],
    targetUserId?: number | null,
    overwriteExisting?: boolean | null,
    skipExisting?: boolean | null,
    useAdmin?: boolean,
    link?: string | null
  ) {
    const body: any = { targetFolderId, folderIds, fileIds, overwrite: overwriteExisting, skipIfExist: skipExisting }
    if (targetUserId) body.targetUserId = targetUserId
    if (useAdmin) body.useAdmin = 1
    return $fetch('/api/copy/paste', {
      method: 'POST',
      body,
      query: link ? { link } : undefined
    })
  }
}