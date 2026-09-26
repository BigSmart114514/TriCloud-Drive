<!-- components/UserInfoCard.vue -->
<template>
  <div class="bg-white shadow rounded-lg p-6">
    <h3 class="text-lg font-medium text-gray-900 mb-4">账户信息</h3>
    <dl class="space-y-4">
      <div>
        <dt class="text-sm font-medium text-gray-500">邮箱</dt>
        <dd class="text-sm text-gray-900">{{ user?.email }}</dd>
      </div>
      <div>
        <dt class="text-sm font-medium text-gray-500">用户名</dt>
        <dd class="text-sm text-gray-900">{{ user?.username }}</dd>
      </div>
      <div>
        <dt class="text-sm font-medium text-gray-500">注册时间</dt>
        <dd class="text-sm text-gray-900">{{ formatDateTime(user?.created_at) }}</dd>
      </div>
      <div>
        <dt class="text-sm font-medium text-gray-500">用户ID</dt>
        <dd class="text-sm text-gray-900">{{ user?.id }}</dd>
      </div>
      <div>
        <dt class="text-sm font-medium text-gray-500">存储已使用</dt>
        <dd class="text-sm text-gray-900">
          {{ formatFileSize(user?.usedStorage || 0) }}/{{ formatFileSize(user?.maxStorage || 0) }}
        </dd>
      </div>
      <div>
        <dt class="text-sm font-medium text-gray-500">下载已使用</dt>
        <dd class="text-sm text-gray-900">
          {{ formatFileSize(user?.usedDownload || 0) }}/{{ formatFileSize(user?.maxDownload || 0) }}
        </dd>
      </div>
      <div>
        <dt class="text-sm font-medium text-gray-500">到期时间</dt>
        <dd class="text-sm text-gray-900">{{ formatDateTime(user?.expire_at) }}</dd>
      </div>
    </dl>
  </div>
</template>

<script setup lang="ts">
import { formatDateTime } from '~/utils/time'
import { formatFileSize } from '~/utils/format'
const { user } = useAuth()
</script>