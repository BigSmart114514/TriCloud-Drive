<template>
  <div :class="framed ? 'bg-white rounded-lg shadow p-4 sm:p-6 transition-colors' : 'transition-colors'">
    <div v-if="loading" class="text-center py-8">
      <div class="inline-flex items-center">
        <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span class="text-gray-600">加载中...</span>
      </div>
    </div>

    <div v-else-if="hasItems" class="space-y-3">
      <div
        v-for="folder in folders"
        :key="`folder-${folder.id}`"
        class="flex items-center gap-2 p-3 sm:p-4 border border-gray-200 rounded-lg hover:bg-gray-50"
      >
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <input
            v-if="selectable"
            type="checkbox"
            class="h-4 w-4 shrink-0 text-indigo-600 rounded border-gray-300"
            :checked="selectedFolderIds?.has(folder.id) || false"
            @change.stop="emit('toggle-folder', folder)"
            @click.stop
            :title="`选择文件夹：${folder.name}`"
          />
          <div class="shrink-0 cursor-pointer relative" @click="emit('navigate-folder', folder)">
            <svg class="h-8 w-8 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h3l2 2h7a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
            <!--
              分享角标：白底圆角小块是必要的 —— Heroicons 是描边风格，
              直接叠在黄色实心文件夹上会糊成一团，看不出是什么图标。
            -->
            <span
              v-if="showShareBadge && folderBadges.get(folder.id)"
              class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded bg-white shadow-sm ring-1 ring-gray-200"
              :title="folderBadgeTitle(folderBadges.get(folder.id)!)"
              :aria-label="folderBadgeTitle(folderBadges.get(folder.id)!)"
            >
              <LockClosedIcon v-if="folderBadges.get(folder.id) === 'lock'" class="h-3 w-3 text-red-500" />
              <UsersIcon v-else-if="folderBadges.get(folder.id) === 'users'" class="h-3 w-3 text-emerald-500" />
              <ShareIcon v-else class="h-3 w-3 text-blue-500" />
            </span>
          </div>
          <div class="flex-1 min-w-0 cursor-pointer" @click="emit('navigate-folder', folder)">
            <p class="text-sm sm:text-base font-medium text-gray-900 truncate">{{ folder.name }}</p>
            <p v-if="folder.relDir" class="text-xs text-gray-400 truncate" :title="folder.relDir">{{ folder.relDir }}</p>
            <p v-if="formatDate(folder.createdAt)" class="text-xs sm:text-sm text-gray-500 truncate">{{ formatDate(folder.createdAt) }}</p>
          </div>
        </div>

        <div v-if="showActions" class="flex items-center gap-1 shrink-0">
          <div class="hidden sm:flex items-center gap-0.5">
            <button
              class="p-1 text-sm text-blue-600 hover:text-blue-500"
              @click.stop="emit('download-folder', folder)"
              :disabled="downloadingFolderId === folder.id"
              title="下载"
              aria-label="下载"
            >
              <svg v-if="downloadingFolderId === folder.id" class="animate-spin h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <ArrowDownTrayIcon v-else class="h-5 w-5" />
            </button>
            <button :disabled="folder.canWrite === false" :class="folder.canWrite === false ? 'opacity-30 cursor-not-allowed' : ''" class="p-1 text-sm text-red-600 hover:text-red-500 disabled:hover:text-red-500" @click.stop="emit('delete-folder', folder)" title="删除" aria-label="删除">
              <TrashIcon class="h-5 w-5" />
            </button>
            <button :disabled="folder.canWrite === false" :class="folder.canWrite === false ? 'opacity-30 cursor-not-allowed' : ''" class="p-1 text-sm text-gray-600 hover:text-gray-800" @click.stop="emit('rename-folder', folder)" title="重命名" aria-label="重命名">
              <PencilSquareIcon class="h-5 w-5" />
            </button>
            <button v-if="showClip" :disabled="folder.canWrite === false" :class="folder.canWrite === false ? 'opacity-30 cursor-not-allowed' : ''" class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="emit('clip-folder', folder)" title="剪贴" aria-label="剪贴">
              <ScissorsIcon class="h-5 w-5" />
            </button>
            <button v-if="showClip" class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="emit('copy-folder', folder)" title="复制" aria-label="复制">
              <DocumentDuplicateIcon class="h-5 w-5" />
            </button>
            <div
              v-if="shareActionOf(folder) !== 'none'"
              class="relative"
              @mouseenter="shareActionOf(folder) === 'inspect' && onPermEnter(folder.id)"
              @mouseleave="shareActionOf(folder) === 'inspect' && onPermLeave()"
            >
              <button
                v-if="shareActionOf(folder) === 'manage'"
                class="p-1 text-sm text-emerald-600 hover:text-emerald-500"
                @click.stop="emit('share-folder', folder)"
                title="分享"
                aria-label="分享"
              >
                <ShareIcon class="h-5 w-5" />
              </button>
              <button
                v-else
                class="p-1 text-sm text-emerald-600 hover:text-emerald-500"
                :aria-expanded="openPermId === folder.id"
                :aria-label="`我对 ${folder.name} 的权限`"
                :title="`权限：${permLabel(permInfo(folder).mask)}（${sourceLabel(permInfo(folder).source)}）`"
                @click.stop="onPermClick(folder.id)"
              >
                <ShareIcon class="h-5 w-5" />
              </button>
              <div
                v-if="openPermId === folder.id"
                role="tooltip"
                class="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-gray-200 bg-white p-2.5 text-xs text-gray-700 shadow-lg"
                @mouseenter="cancelClose()"
                @mouseleave="onPermLeave()"
              >
                <p class="mb-1 truncate font-medium text-gray-900">{{ folder.name }}</p>
                <p class="flex justify-between gap-2"><span class="text-gray-500">权限</span><span>{{ permLabel(permInfo(folder).mask) }}</span></p>
                <p class="flex justify-between gap-2"><span class="text-gray-500">来源</span><span>{{ sourceLabel(permInfo(folder).source) }}</span></p>
                <p class="flex justify-between gap-2"><span class="text-gray-500">公开</span><span>{{ permInfo(folder).public ? '是' : '否' }}</span></p>
              </div>
            </div>
          </div>
          <div class="flex sm:hidden items-center gap-1">
            <button class="p-1 text-blue-600 hover:text-blue-500" :disabled="downloadingFolderId === folder.id" @click.stop="emit('download-folder', folder)" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-gray-600 hover:text-gray-800" @click.stop="openRowMenu('folder', folder)" title="更多" aria-label="更多">
              <EllipsisVerticalIcon class="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div
        v-for="file in files"
        :key="`file-${file.id}`"
        class="flex items-center gap-2 p-3 sm:p-4 border border-gray-200 rounded-lg hover:bg-gray-50"
      >
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <input
            v-if="selectable"
            type="checkbox"
            class="h-4 w-4 shrink-0 text-indigo-600 rounded border-gray-300"
            :checked="selectedFileIds?.has(file.id) || false"
            @change.stop="emit('toggle-file', file)"
            @click.stop
            :title="`选择文件：${file.filename}`"
          />
          <div class="shrink-0">
            <FileIcon class="h-8 w-8 text-gray-400" :filename="file.filename" />
          </div>
          <div class="flex-1 min-w-0 cursor-pointer" @click="emit('preview-file', file)">
            <p class="text-sm sm:text-base font-medium text-gray-900 truncate">{{ file.filename }}</p>
            <p v-if="file.relDir" class="text-xs text-gray-400 truncate" :title="file.relDir">{{ file.relDir }}</p>
            <p class="text-xs sm:text-sm text-gray-500 truncate">
              {{ formatFileSize(file.fileSize) }}<span v-if="formatDate(file.createdAt)"> • {{ formatDate(file.createdAt) }}</span>
            </p>
          </div>
        </div>

        <div v-if="showActions" class="flex items-center gap-1 shrink-0">
          <div class="hidden sm:flex items-center gap-0.5">
            <button class="p-1 text-sm text-blue-600 hover:text-blue-500" @click.stop="emit('download-file', file)" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button :disabled="file.canWrite === false" :class="file.canWrite === false ? 'opacity-30 cursor-not-allowed' : ''" class="p-1 text-sm text-gray-600 hover:text-gray-800" @click.stop="emit('rename-file', file)" title="重命名" aria-label="重命名">
              <PencilSquareIcon class="h-5 w-5" />
            </button>
            <button :disabled="file.canWrite === false" :class="file.canWrite === false ? 'opacity-30 cursor-not-allowed' : ''" class="p-1 text-sm text-red-600 hover:text-red-500" @click.stop="emit('delete-file', file)" title="删除" aria-label="删除">
              <TrashIcon class="h-5 w-5" />
            </button>
            <button v-if="showClip" :disabled="file.canWrite === false" :class="file.canWrite === false ? 'opacity-30 cursor-not-allowed' : ''" class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="emit('clip-file', file)" title="剪贴" aria-label="剪贴">
              <ScissorsIcon class="h-5 w-5" />
            </button>
            <button v-if="showClip" class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="emit('copy-file', file)" title="复制" aria-label="复制">
              <DocumentDuplicateIcon class="h-5 w-5" />
            </button>
            <div
              v-if="shareActionOf(file) !== 'none'"
              class="relative"
              @mouseenter="shareActionOf(file) === 'inspect' && onPermEnter(file.id)"
              @mouseleave="shareActionOf(file) === 'inspect' && onPermLeave()"
            >
              <button
                v-if="shareActionOf(file) === 'manage'"
                class="p-1 text-sm text-emerald-600 hover:text-emerald-500"
                @click.stop="emit('share-file', file)"
                title="分享"
                aria-label="分享"
              >
                <ShareIcon class="h-5 w-5" />
              </button>
              <button
                v-else
                class="p-1 text-sm text-emerald-600 hover:text-emerald-500"
                :aria-expanded="openPermId === file.id"
                :aria-label="`我对 ${file.filename} 的权限`"
                :title="`权限：${permLabel(permInfo(file).mask)}（${sourceLabel(permInfo(file).source)}）`"
                @click.stop="onPermClick(file.id)"
              >
                <ShareIcon class="h-5 w-5" />
              </button>
              <div
                v-if="openPermId === file.id"
                role="tooltip"
                class="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-gray-200 bg-white p-2.5 text-xs text-gray-700 shadow-lg"
                @mouseenter="cancelClose()"
                @mouseleave="onPermLeave()"
              >
                <p class="mb-1 truncate font-medium text-gray-900">{{ file.filename }}</p>
                <p class="flex justify-between gap-2"><span class="text-gray-500">权限</span><span>{{ permLabel(permInfo(file).mask) }}</span></p>
                <p class="flex justify-between gap-2"><span class="text-gray-500">来源</span><span>{{ sourceLabel(permInfo(file).source) }}</span></p>
                <p class="flex justify-between gap-2"><span class="text-gray-500">公开</span><span>{{ permInfo(file).public ? '是' : '否' }}</span></p>
              </div>
            </div>
          </div>
          <div class="flex sm:hidden items-center gap-1">
            <button class="p-1 text-blue-600 hover:text-blue-500" @click.stop="emit('download-file', file)" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-gray-600 hover:text-gray-800" @click.stop="openRowMenu('file', file)" title="更多" aria-label="更多">
              <EllipsisVerticalIcon class="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="text-center py-8">
      <svg class="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
        <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <h3 class="mt-2 text-sm font-medium text-gray-900">{{ emptyTitle }}</h3>
      <p class="mt-1 text-sm text-gray-500">{{ emptyDescription }}</p>
    </div>

    <transition name="fade">
      <div v-if="rowMenuOpen" class="fixed inset-0 z-50 sm:hidden">
        <div class="absolute inset-0 bg-black/30" @click="closeRowMenu" />
        <div data-liquid class="ui-glass absolute inset-x-0 bottom-0 bg-white rounded-t-2xl p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-xl">
          <div class="mx-auto h-1.5 w-12 rounded bg-gray-300 mb-3" />
          <!-- 文件 6 项排 3×2，文件夹 5 项排一行，避免落单换行 -->
          <div
            class="grid gap-2 text-center text-xs"
            :class="rowMenu?.type === 'file' ? 'grid-cols-3' : 'grid-cols-5'"
          >
            <template v-if="rowMenu?.type === 'file'">
              <button class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('preview-file')">
                <EyeIcon class="h-6 w-6 text-gray-700" />
                <span class="mt-1">预览</span>
              </button>
              <button :disabled="!menuWritable" :class="menuWritable ? '' : 'opacity-30'" class="px-2 py-3 rounded hover:bg-gray-50 disabled:hover:bg-transparent flex flex-col items-center justify-center" @click="runFileAction('rename-file')">
                <PencilSquareIcon class="h-6 w-6 text-gray-700" />
                <span class="mt-1">重命名</span>
              </button>
              <button :disabled="!menuWritable" :class="menuWritable ? '' : 'opacity-30'" class="px-2 py-3 rounded hover:bg-gray-50 disabled:hover:bg-transparent flex flex-col items-center justify-center" @click="runFileAction('delete-file')">
                <TrashIcon class="h-6 w-6 text-red-600" />
                <span class="mt-1">删除</span>
              </button>
              <button v-if="showClip" :disabled="!menuWritable" :class="menuWritable ? '' : 'opacity-30'" class="px-2 py-3 rounded hover:bg-gray-50 disabled:hover:bg-transparent flex flex-col items-center justify-center" @click="runFileAction('clip-file')">
                <ScissorsIcon class="h-6 w-6 text-indigo-600" />
                <span class="mt-1">剪贴</span>
              </button>
              <button v-if="showClip" class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('copy-file')">
                <DocumentDuplicateIcon class="h-6 w-6 text-indigo-600" />
                <span class="mt-1">复制</span>
              </button>
              <button v-if="shareActionOf(rowMenu.item as FileListFile) === 'manage'" class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFileAction('share-file')">
                <ShareIcon class="h-6 w-6 text-emerald-600" />
                <span class="mt-1">分享</span>
              </button>
              <div
                v-else-if="shareActionOf(rowMenu.item as FileListFile) === 'inspect'"
                class="px-2 py-3 flex flex-col gap-0.5"
                role="tooltip"
              >
                <span class="flex items-center gap-1.5 text-xs font-medium text-gray-900">
                  <ShareIcon class="h-4 w-4 text-emerald-600" />我的权限
                </span>
                <span class="text-xs text-gray-500">{{ permLabel(permInfo(rowMenu.item as FileListFile).mask) }} · {{ sourceLabel(permInfo(rowMenu.item as FileListFile).source) }}</span>
                <span class="text-xs text-gray-400">公开：{{ permInfo(rowMenu.item as FileListFile).public ? '是' : '否' }}</span>
              </div>
            </template>
            <template v-else-if="rowMenu?.type === 'folder'">
              <button :disabled="!menuWritable" :class="menuWritable ? '' : 'opacity-30'" class="px-2 py-3 rounded hover:bg-gray-50 disabled:hover:bg-transparent flex flex-col items-center justify-center" @click="runFolderAction('rename-folder')">
                <PencilSquareIcon class="h-6 w-6 text-gray-700" />
                <span class="mt-1">重命名</span>
              </button>
              <button :disabled="!menuWritable" :class="menuWritable ? '' : 'opacity-30'" class="px-2 py-3 rounded hover:bg-gray-50 disabled:hover:bg-transparent flex flex-col items-center justify-center" @click="runFolderAction('delete-folder')">
                <TrashIcon class="h-6 w-6 text-red-600" />
                <span class="mt-1">删除</span>
              </button>
              <button v-if="showClip" :disabled="!menuWritable" :class="menuWritable ? '' : 'opacity-30'" class="px-2 py-3 rounded hover:bg-gray-50 disabled:hover:bg-transparent flex flex-col items-center justify-center" @click="runFolderAction('clip-folder')">
                <ScissorsIcon class="h-6 w-6 text-indigo-600" />
                <span class="mt-1">剪贴</span>
              </button>
              <button v-if="showClip" class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFolderAction('copy-folder')">
                <DocumentDuplicateIcon class="h-6 w-6 text-indigo-600" />
                <span class="mt-1">复制</span>
              </button>
              <button v-if="shareActionOf(rowMenu.item as FileListFolder) === 'manage'" class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center" @click="runFolderAction('share-folder')">
                <ShareIcon class="h-6 w-6 text-emerald-600" />
                <span class="mt-1">分享</span>
              </button>
              <div
                v-else-if="shareActionOf(rowMenu.item as FileListFolder) === 'inspect'"
                class="px-2 py-3 flex flex-col gap-0.5"
                role="tooltip"
              >
                <span class="flex items-center gap-1.5 text-xs font-medium text-gray-900">
                  <ShareIcon class="h-4 w-4 text-emerald-600" />我的权限
                </span>
                <span class="text-xs text-gray-500">{{ permLabel(permInfo(rowMenu.item as FileListFolder).mask) }} · {{ sourceLabel(permInfo(rowMenu.item as FileListFolder).source) }}</span>
                <span class="text-xs text-gray-400">公开：{{ permInfo(rowMenu.item as FileListFolder).public ? '是' : '否' }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { formatFileSize } from '~/utils/format'
import { formatDateTime } from '~/utils/time'
import FileIcon from '~/components/FileIcon.vue'
import type { FileListFile, FileListFolder, FileListId } from '~~/types/file-list'
import { resolveShareBadge, SHARE_BADGE_LABELS } from '~~/types/share'
import type { ShareBadge } from '~~/types/share'
import {
  ArrowDownTrayIcon,
  DocumentDuplicateIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  LockClosedIcon,
  PencilSquareIcon,
  ScissorsIcon,
  ShareIcon,
  TrashIcon,
  UsersIcon
} from '@heroicons/vue/24/outline'

const props = withDefaults(defineProps<{
  folders?: FileListFolder[]
  files?: FileListFile[]
  loading?: boolean
  selectable?: boolean
  showActions?: boolean
  framed?: boolean
  downloadingFolderId?: FileListId | null
  selectedFolderIds?: ReadonlySet<FileListId>
  selectedFileIds?: ReadonlySet<FileListId>
  /**
   * 是否显示剪贴/复制按钮。是否可点由条目自身的 canWrite 决定，
   * 所以共享视图也传 true —— 只读条目会置灰而不是消失。
   */
  showClip?: boolean
  /**
   * 分享按钮的行为：
   *   manage  —— 我是属主，点击打开分享弹窗改授权
   *   inspect —— 不是我自己的，点击/悬停展示「我对这个条目所有的权限」
   *   none    —— 不给这个按钮（默认；ZipPreview 等调用方不传）
   */
  shareAction?: (item: FileListFile | FileListFolder) => 'manage' | 'inspect' | 'none'
  /**
   * 是否在文件夹图标上显示分享角标（不分享 / 公开 / 已分享）。
   * 只有「我的文件」该显示 —— 共享清单里那些是别人的目录，属主设的角标会误导。
   */
  showShareBadge?: boolean
  emptyTitle?: string
  emptyDescription?: string
}>(), {
  folders: () => [],
  files: () => [],
  loading: false,
  selectable: true,
  showActions: true,
  framed: true,
  downloadingFolderId: null,
  selectedFolderIds: undefined,
  selectedFileIds: undefined,
  showClip: true,
  shareAction: () => 'none',
  showShareBadge: false,
  emptyTitle: '这里空空如也',
  emptyDescription: '当前目录没有可显示的内容。'
})

const emit = defineEmits<{
  'navigate-folder': [folder: FileListFolder]
  'preview-file': [file: FileListFile]
  'toggle-folder': [folder: FileListFolder]
  'toggle-file': [file: FileListFile]
  'download-folder': [folder: FileListFolder]
  'delete-folder': [folder: FileListFolder]
  'rename-folder': [folder: FileListFolder]
  'clip-folder': [folder: FileListFolder]
  'copy-folder': [folder: FileListFolder]
  'download-file': [file: FileListFile]
  'delete-file': [file: FileListFile]
  'rename-file': [file: FileListFile]
  'clip-file': [file: FileListFile]
  'copy-file': [file: FileListFile]
  'share-file': [file: FileListFile]
  'share-folder': [folder: FileListFolder]
}>()

const hasItems = computed(() => props.folders.length + props.files.length > 0)

const shareActionOf = (item: FileListFile | FileListFolder) => props.shareAction(item)

/* ---------- 「你对这个条目所有的权限」 ---------- */

const PERM_LABELS: { key: string; label: string }[] = [
  { key: 'read', label: '读' },
  { key: 'write', label: '写' },
  { key: 'delete', label: '删' }
]

const SOURCE_LABELS: Record<string, string> = {
  owner: '我是属主',
  self: '直接授权给我',
  inherited: '继承自上级目录',
  public: '该内容对所有登录用户公开',
  none: '无访问权'
}

const permInfo = (item: FileListFile | FileListFolder) => {
  const mask = Number((item as { perm?: number }).perm ?? (item.canWrite === false ? 1 : 7))
  const src = (item as { permSource?: string }).permSource
  return {
    mask,
    source: src ?? (item.ownerId == null ? 'none' : 'self'),
    public: item.IsPublic === true,
    isPublicSource: src === 'public'
  }
}
const permLabel = (mask: number) => (mask === 0 ? '无权限' : PERM_LABELS.map(p => {
  const bit = p.key === 'read' ? 1 : p.key === 'write' ? 2 : 4
  return mask & bit ? p.label : ''
}).filter(Boolean).join(' / '))
const sourceLabel = (src: string) => SOURCE_LABELS[src] ?? '未知'

/**
 * 文件夹图标上的分享角标。只在「我的文件」视角下有意义（共享清单里那些是
 * 别人的目录，角标会误导），所以由父级用 v-if 控是否传入。
 * 判定规则见 types/share.ts 的 resolveShareBadge。
 */
const folderBadge = (folder: FileListFolder): ShareBadge | null =>
  resolveShareBadge({ Shared: folder.Shared, IsPublic: folder.IsPublic, grantCount: folder.grantCount })
const folderBadgeTitle = (badge: ShareBadge): string => SHARE_BADGE_LABELS[badge]

// 按 id 预计算，避免模板里每个文件夹调三次 folderBadge
const folderBadges = computed(() => {
  const map = new Map<FileListId, ShareBadge | null>()
  for (const f of props.folders) map.set(f.id, folderBadge(f))
  return map
})

/**
 * 悬停即出、移开即收；点击钉住，方便停留和复制文字。
 * 关闭有 120ms 延时，鼠标从按钮移到弹层上不会先消失。
 */
const hoveredId = ref<FileListId | null>(null)
const pinnedId = ref<FileListId | null>(null)
let closeTimer: ReturnType<typeof setTimeout> | undefined

const cancelClose = () => clearTimeout(closeTimer)
const scheduleClose = () => {
  cancelClose()
  closeTimer = setTimeout(() => { hoveredId.value = null }, 120)
}
const onPermEnter = (id: FileListId) => { cancelClose(); hoveredId.value = id }
const onPermLeave = () => { if (pinnedId.value === null) scheduleClose() }
const onPermClick = (id: FileListId) => {
  cancelClose()
  pinnedId.value = pinnedId.value === id ? null : id
  hoveredId.value = id
}
const openPermId = computed(() => pinnedId.value ?? hoveredId.value)
const onPermKeydown = (e: KeyboardEvent) => { if (e.key === 'Escape') pinnedId.value = null }
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onPermKeydown)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onPermKeydown)
    clearTimeout(closeTimer)
  })
}

/** 行菜单里重命名/删除/剪贴是否可点。undefined 视为可写（ZipPreview 等旧调用方） */
const menuWritable = computed(() => (rowMenu.value?.item as any)?.canWrite !== false)
const rowMenuOpen = ref(false)
const rowMenu = ref<{ type: 'file' | 'folder'; item: FileListFile | FileListFolder } | null>(null)

const formatDate = (value?: string | null) => formatDateTime(value)

const openRowMenu = (type: 'file' | 'folder', item: FileListFile | FileListFolder) => {
  rowMenu.value = { type, item }
  rowMenuOpen.value = true
}

const closeRowMenu = () => {
  rowMenuOpen.value = false
  rowMenu.value = null
}

const runFileAction = (
  action: 'preview-file' | 'rename-file' | 'delete-file' | 'clip-file' | 'copy-file' | 'share-file'
) => {
  if (rowMenu.value?.type !== 'file') return
  const file = rowMenu.value.item as FileListFile
  if (action === 'preview-file') emit('preview-file', file)
  if (action === 'rename-file') {
    if (!menuWritable.value) return
    emit('rename-file', file)
  }
  if (action === 'delete-file') {
    if (!menuWritable.value) return
    emit('delete-file', file)
  }
  if (action === 'clip-file') {
    if (!menuWritable.value) return
    emit('clip-file', file)
  }
  if (action === 'copy-file') emit('copy-file', file)
  if (action === 'share-file' && shareActionOf(file) === 'manage') emit('share-file', file)
  closeRowMenu()
}

const runFolderAction = (
  action: 'rename-folder' | 'delete-folder' | 'clip-folder' | 'copy-folder' | 'share-folder'
) => {
  if (rowMenu.value?.type !== 'folder') return
  const folder = rowMenu.value.item as FileListFolder
  if (action === 'rename-folder') {
    if (!menuWritable.value) return
    emit('rename-folder', folder)
  }
  if (action === 'delete-folder') {
    if (!menuWritable.value) return
    emit('delete-folder', folder)
  }
  if (action === 'clip-folder') {
    if (!menuWritable.value) return
    emit('clip-folder', folder)
  }
  if (action === 'copy-folder') emit('copy-folder', folder)
  if (action === 'share-folder' && shareActionOf(folder) === 'manage') emit('share-folder', folder)
  closeRowMenu()
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
