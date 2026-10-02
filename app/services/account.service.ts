// 子账户的接口调用与类型。
//
// 字段名与服务端 accounts/*.get 返回的对齐，不做前端重命名 ——
// 额度那几个尤其不能转，单位换算（字节 ↔ 「10 GB」）只在
// QuotaFields 的 @blur 与本页的保存时各做一次。

/** 列表里的一行 */
export interface SubAccount {
  id: number
  username: string
  email: string
  createdAt: string
  expireAt: string | null
  /** 服务端算好的，前端不自己判过期（时区口径只有服务端一个来源） */
  expired: boolean
  usedStorage: number
  maxStorage: number
  usedDownload: number
  maxDownload: number
}

/** 池的用量。own 是主账号自己那份，children 是实时 SUM 出来的 */
export interface SubAccountPoolPart {
  own: number
  children: number
  total: number
  max: number
}

export interface SubAccountCapability {
  canSubAccount: boolean
  maxSubAccount: number
  /** 我自己是别人的子账户吗 */
  isChild: boolean
}

export interface SubAccountsResponse {
  success: boolean
  children: SubAccount[]
  pool: { storage: SubAccountPoolPart; download: SubAccountPoolPart }
  capability: SubAccountCapability
  totalCount: number
}

export interface CreateChildPayload {
  email: string
  username: string
  password: string
  /** 0 = 不限（受主账号的池兜底）。不要写 1，users 表默认值是 1 也就是 1 字节 */
  maxStorage?: number
  maxDownload?: number
  /** 空 = 永不过期 */
  expire_at?: string | null
}

export const AccountService = {
  /** 列表 + 池汇总 + 建号能力。username 非空时按名字过滤 */
  async list(username?: string): Promise<SubAccountsResponse> {
    return await $fetch<SubAccountsResponse>('/api/accounts', {
      method: 'GET',
      params: username ? { username } : {}
    })
  },

  /** 建子账户。服务端强制普通用户身份、不能改密码、不超过 maxSubAccount */
  async create(payload: CreateChildPayload): Promise<{ success: boolean; statusMessage: string }> {
    return await $fetch<{ success: boolean; statusMessage: string }>(`/api/accounts`, { method: 'POST', body: payload })
  },

  /** 改某个子账户的额度 / 到期时间。只认这几个字段，角色与 parent_id 不在其中 */
  async updateQuota(
    id: number,
    payload: { maxStorage?: number; maxDownload?: number; expire_at?: string | null }
  ): Promise<{ success: boolean; statusMessage: string }> {
    return await $fetch<{ success: boolean; statusMessage: string }>(`/api/accounts/quota`, { method: 'POST', body: { id, ...payload } })
  },

  /** 重置密码。子账户自己不能改密码（canChangePassword = 0），这是唯一出路 */
  async resetPassword(id: number, newPassword: string): Promise<{ success: boolean; statusMessage: string }> {
    return await $fetch<{ success: boolean; statusMessage: string }>(`/api/accounts/reset-password`, { method: 'POST', body: { id, newPassword } })
  },

  /** 删除。连 COS 对象一起清；池的额度自动退回（池是实时 SUM，不需要反向记账） */
  async remove(id: number): Promise<{ success: boolean; statusMessage: string }> {
    return await $fetch<{ success: boolean; statusMessage: string }>(`/api/accounts/delete`, { method: 'POST', body: { id } })
  }
}