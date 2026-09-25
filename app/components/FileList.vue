<template>
  <div
    class="bg-white rounded-lg shadow p-4 sm:p-6 transition-colors"
    @dragover.prevent
    @dragenter.prevent="onDragEnter"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="handleDrop"
    :class="{ 'border-2 border-dashed border-indigo-400 bg-indigo-50': isDragging }"
  >
    <!-- 顶部：标题 + 面包屑 + 工具栏（可换行） -->
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <!-- 小屏隐藏“全选”，避免拥挤 -->
        <input
          ref="masterCheckboxRef"
          type="checkbox"
          class="h-4 w-4 text-indigo-600 rounded border-gray-300 hidden sm:block"
          :checked="isAllSelected"
          :disabled="!hasItems"
          @change="toggleSelectAll"
          title="全选/全不选"
        />
        <h3 class="text-lg font-medium text-gray-900 shrink-0">{{ title || '我的文件' }}</h3>

        <!-- 面包屑横向滚动，避免挤占空间 -->
        <nav class="text-sm text-gray-500 overflow-x-auto whitespace-nowrap no-scrollbar max-w-[60vw] sm:max-w-none">
          <span v-for="(crumb, idx) in breadcrumbs" :key="String(crumb.id) + '-' + idx">
            <span v-if="idx > 0" class="mx-1">/</span>
            <button class="hover:text-indigo-600" @click="handleGoToBreadcrumb(idx)" :disabled="idx === breadcrumbs.length - 1">
              {{ crumb.name }}
            </button>
          </span>
        </nav>
      </div>

      <!-- 顶部工具栏（图标化） -->
      <div class="flex items-center gap-2">
        <!-- 返回上一级 -->
        <button
          class="p-1 text-sm text-gray-600 hover:text-gray-800"
          v-if="breadcrumbs.length > 1"
          @click="handleGoUp"
          title="返回上一级"
          aria-label="返回上一级"
        >
          <ArrowLeftIcon class="h-5 w-5" />
        </button>

        <!-- 批量删除（小屏隐藏，进“更多”） -->
        <button
          class="p-1 text-sm text-red-600 hover:text-red-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="selectedCount === 0 || bulkDeleting"
          @click="deleteSelected"
          title="删除所选"
          aria-label="删除所选"
        >
          <TrashIcon class="h-5 w-5" />
        </button>

        <!-- 批量下载（小屏隐藏，进“更多”） -->
        <button
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="selectedCount === 0 || bulkDownloading"
          @click="downloadSelected"
          title="下载所选"
          aria-label="下载所选"
        >
          <ArrowDownTrayIcon class="h-5 w-5" />
        </button>

        <!-- 剪贴（小屏隐藏，进“更多”） -->
        <button
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="selectedCount === 0"
          @click="clipSelection"
          title="剪贴所选（移动）"
          aria-label="剪贴所选（移动）"
        >
          <ScissorsIcon class="h-5 w-5" />
        </button>

        <!-- 复制（小屏隐藏，进“更多”） -->
        <button
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="selectedCount === 0"
          @click="copySelection"
          title="复制所选（拷贝）"
          aria-label="复制所选（拷贝）"
        >
          <DocumentDuplicateIcon class="h-5 w-5" />
        </button>

        <!-- 粘贴（小屏隐藏，进“更多”） -->
        <button
          class="p-1 text-sm text-green-600 hover:text-green-500 disabled:opacity-50 hidden sm:inline-flex"
          :disabled="!hasClipboard || pasting"
          @click="pasteClipboard"
          :title="clipboard?.mode === 'cut' ? '移动到当前文件夹' : '复制到当前文件夹'"
          aria-label="粘贴到当前文件夹"
        >
          <ClipboardDocumentCheckIcon class="h-5 w-5" />
        </button>

        <span v-if="hasClipboard" class="text-xs text-gray-500 hidden sm:inline">
          {{ clipboardActionLabel }} {{ clipboardCount }} 项
        </span>

        <!-- 上传按钮（悬浮菜单） -->
        <div class="relative" ref="uploadMenuRef" @mouseenter="openUploadMenu" @mouseleave="scheduleCloseUploadMenu">
          <button
            class="p-1 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
            @click.stop="toggleUploadMenu"
            title="上传"
            aria-label="上传"
          >
            <ArrowUpTrayIcon class="h-5 w-5" />
          </button>

          <!-- 移动端点击遮罩：点击外部关闭上传菜单；桌面端不显示遮罩 -->
          <div v-if="showUploadMenu" class="fixed inset-0 z-10 sm:hidden" @click="closeUploadMenu"></div>

          <transition name="fade-slide">
            <div
              v-show="showUploadMenu"
              class="absolute right-0 mt-2 w-44 z-20 bg-white border border-gray-200 rounded-md shadow-lg"
              @mouseenter="openUploadMenu"
              @mouseleave="scheduleCloseUploadMenu"
            >
              <button class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2" @click="fileInputRef?.click()">
                <DocumentArrowUpIcon class="h-5 w-5 text-gray-500" />
                上传文件
              </button>
              <button class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2" @click="folderInputRef?.click()">
                <FolderPlusIcon class="h-5 w-5 text-gray-500" />
                上传文件夹
              </button>
              <!-- 冲突策略保留 -->
              <div class="px-4 py-2 border-t border-gray-100">
                <div class="space-y-2 text-xs text-gray-600">
                  <label class="flex items-center gap-2">
                    <input type="radio" name="upload-conflict" class="text-indigo-600" value="overwrite" v-model="conflictStrategy" />
                    同名时覆盖
                  </label>
                  <label class="flex items-center gap-2">
                    <input type="radio" name="upload-conflict" class="text-indigo-600" value="skip" v-model="conflictStrategy" />
                    同名时跳过
                  </label>
                  <label class="flex items-center gap-2">
                    <input type="radio" name="upload-conflict" class="text-indigo-600" value="rename" v-model="conflictStrategy" />
                    自动重命名
                  </label>
                </div>
              </div>
            </div>
          </transition>
        </div>

        <!-- 新建文件夹（小屏隐藏，进“更多”） -->
        <button
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500 hidden sm:inline-flex"
          @click="createFolder"
          title="新建文件夹"
          aria-label="新建文件夹"
        >
          <FolderPlusIcon class="h-5 w-5" />
        </button>

        <!-- 刷新 -->
        <button
          @click="fetchFiles"
          class="p-1 text-sm text-indigo-600 hover:text-indigo-500"
          title="刷新"
          aria-label="刷新"
        >
          <ArrowPathIcon class="h-5 w-5" />
        </button>

        <!-- 小屏“更多”菜单（有图标） -->
        <div class="relative sm:hidden">
          <button class="p-1 text-gray-600 hover:text-gray-800" @click.stop="mobileMoreOpen = !mobileMoreOpen" title="更多" aria-label="更多">
            <EllipsisVerticalIcon class="h-5 w-5" />
          </button>

          <!-- 移动端点击遮罩：点击外部关闭更多菜单 -->
          <template v-if="mobileMoreOpen">
            <div class="fixed inset-0 z-10" @click="mobileMoreOpen=false"></div>
            <div
              class="absolute right-0 mt-2 w-48 z-20 bg-white border border-gray-200 rounded-md shadow-lg py-1"
            >
              <button
                class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700"
                :disabled="selectedCount === 0 || bulkDeleting"
                @click="deleteSelected(); mobileMoreOpen=false"
                aria-label="删除所选"
              >
                <TrashIcon class="h-5 w-5 text-red-600" />
                删除所选
              </button>
              <button
                class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700"
                :disabled="selectedCount === 0 || bulkDownloading"
                @click="downloadSelected(); mobileMoreOpen=false"
                aria-label="下载所选"
              >
                <ArrowDownTrayIcon class="h-5 w-5 text-indigo-600" />
                下载所选
              </button>
              <button
                class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700"
                :disabled="selectedCount === 0"
                @click="clipSelection(); mobileMoreOpen=false"
                aria-label="剪贴所选"
              >
                <ScissorsIcon class="h-5 w-5 text-indigo-600" />
                剪贴所选
              </button>
              <button
                class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700"
                :disabled="selectedCount === 0"
                @click="copySelection(); mobileMoreOpen=false"
                aria-label="复制所选"
              >
                <DocumentDuplicateIcon class="h-5 w-5 text-indigo-600" />
                复制所选
              </button>
              <button
                class="w-full px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-gray-700"
                :disabled="!hasClipboard || pasting"
                @click="pasteClipboard(); mobileMoreOpen=false"
                aria-label="粘贴"
              >
                <ClipboardDocumentCheckIcon class="h-5 w-5 text-green-600" />
                {{ clipboard?.mode === 'cut' ? '粘贴（移动）' : '粘贴（复制）' }}
              </button>
              <div class="border-t border-gray-100 my-1"></div>
              <button
                class="w-full px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 text-gray-700"
                @click="createFolder(); mobileMoreOpen=false"
                aria-label="新建文件夹"
              >
                <FolderPlusIcon class="h-5 w-5 text-indigo-600" />
                新建文件夹
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 隐藏的文件选择器 -->
    <input ref="fileInputRef" type="file" multiple class="hidden" @change="handleFileSelect" />
    <input ref="folderInputRef" type="file" webkitdirectory directory multiple class="hidden" @change="handleFolderSelect" />

    <!-- 上传进度与错误 -->
    <div v-if="uploading" class="mt-2 mb-4">
      <div class="flex items-center justify-between text-sm text-gray-600 mb-2">
        <span>上传中...</span>
        <span>{{ uploadProgress.percent }}%</span>
      </div>
      <div class="w-full bg-gray-200 rounded-full h-2">
        <div class="bg-indigo-600 h-2 rounded-full transition-all duration-300" :style="{ width: uploadProgress.percent + '%' }"></div>
      </div>
    </div>
    <div v-if="uploadError" class="mt-2 mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
      {{ uploadError }}
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="text-center py-8">
      <div class="inline-flex items-center">
        <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z">
          </path>
        </svg>
        <span class="text-gray-600">加载中...</span>
      </div>
    </div>

    <!-- 列表 -->
    <div v-else-if="hasItems" class="space-y-3">
      <!-- 文件夹 -->
      <div
        v-for="folder in folders"
        :key="'folder-' + folder.id"
        class="flex items-center gap-2 p-3 sm:p-4 border border-gray-200 rounded-lg hover:bg-gray-50"
      >
        <!-- 左侧：flex-1 + min-w-0 才能让 truncate 生效 -->
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 text-indigo-600 rounded border-gray-300"
            :checked="selectedFolderIds.has(folder.id)"
            @change.stop="toggleSelectFolder(folder)"
            @click.stop
            :title="`选择文件夹：${folder.name}`"
          />
          <div class="shrink-0 cursor-pointer" @click="handleNavigateToFolder(folder)">
            <svg class="h-8 w-8 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h3l2 2h7a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          </div>
          <div class="flex-1 min-w-0 cursor-pointer" @click="handleNavigateToFolder(folder)">
            <p class="text-sm sm:text-base font-medium text-gray-900 truncate">
              {{ folder.name }}
            </p>
            <p class="text-xs sm:text-sm text-gray-500 truncate">
              {{ formatToUTC8(folder.createdAt) }}
            </p>
          </div>
        </div>

        <!-- 右侧：shrink-0 + 紧凑间距 -->
        <div class="flex items-center gap-1 shrink-0">
          <!-- 大屏：完整按钮组 -->
          <div class="hidden sm:flex items-center gap-0.5">
            <button
              class="p-1 text-sm text-blue-600 hover:text-blue-500"
              @click.stop="downloadFolder(folder)"
              :disabled="downloadingFolderId2 === folder.id"
              title="下载"
              aria-label="下载"
            >
              <template v-if="downloadingFolderId2 === folder.id">
                <svg class="animate-spin h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </template>
              <template v-else>
                <ArrowDownTrayIcon class="h-5 w-5" />
              </template>
            </button>
            <button class="p-1 text-sm text-red-600 hover:text-red-500" @click.stop="deleteFolder(folder)" title="删除" aria-label="删除">
              <TrashIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-gray-600 hover:text-gray-800" @click.stop="renameFolder(folder)" title="重命名" aria-label="重命名">
              <PencilSquareIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="clipFolder(folder)" title="剪贴" aria-label="剪贴">
              <ScissorsIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-sm text-indigo-600 hover:text-indigo-500" @click.stop="copyFolder(folder)" title="复制" aria-label="复制">
              <DocumentDuplicateIcon class="h-5 w-5" />
            </button>
            <!-- <button
              class="p-1 flex items-center text-sm text-gray-400 hover:text-gray-600"
              @click="handleNavigateToFolder(folder)"
              title="进入"
              aria-label="进入"
            >
              <ArrowRightIcon class="h-5 w-5" />
            </button> -->
          </div>

          <!-- 小屏：下载 + 更多 + 进入 -->
          <div class="flex sm:hidden items-center gap-1">
            <button class="p-1 text-blue-600 hover:text-blue-500" @click.stop="downloadFolder(folder)" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-gray-600 hover:text-gray-800" @click.stop="openRowMenu('folder', folder)" title="更多" aria-label="更多">
              <EllipsisVerticalIcon class="h-5 w-5" />
            </button>
            <!-- <button
              class="p-1 flex items-center text-sm text-gray-400 hover:text-gray-600"
              @click="handleNavigateToFolder(folder)"
              title="进入"
              aria-label="进入"
            >
              <ArrowRightIcon class="h-5 w-5" />
            </button> -->
          </div>
        </div>
      </div>

      <!-- 文件 -->
      <div
        v-for="file in files"
        :key="'file-' + file.id"
        class="flex items-center gap-2 p-3 sm:p-4 border border-gray-200 rounded-lg hover:bg-gray-50"
      >
        <!-- 左侧：flex-1 + min-w-0 -->
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 text-indigo-600 rounded border-gray-300"
            :checked="selectedFileIds.has(file.id)"
            @change.stop="toggleSelectFile(file)"
            @click.stop
            :title="`选择文件：${file.filename}`"
          />
          <div class="shrink-0">
            <FileIcon class="h-8 w-8 text-gray-400" :filename="file.filename" />
          </div>
          <div class="flex-1 min-w-0 cursor-pointer" @click="openPreview(file)">
            <p class="text-sm sm:text-base font-medium text-gray-900 truncate">
              {{ file.filename }}
            </p>
            <p class="text-xs sm:text-sm text-gray-500 truncate">
              {{ formatFileSize(file.fileSize) }} • {{ formatToUTC8(file.createdAt) }}
            </p>
          </div>
        </div>

        <!-- 右侧：shrink-0 + 紧凑间距 -->
        <div class="flex items-center gap-1 shrink-0">
          <!-- 大屏：完整按钮组 -->
          <div class="hidden sm:flex items-center gap-0.5">
            <!-- <button @click="openPreview(file)" class="p-1 text-sm text-gray-600 hover:text-gray-800" title="预览" aria-label="预览">
              <EyeIcon class="h-5 w-5" />
            </button> -->
            <button @click="downloadFile(file)" class="p-1 text-sm text-blue-600 hover:text-blue-500" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button @click="renameFile(file)" class="p-1 text-sm text-gray-600 hover:text-gray-800" title="重命名" aria-label="重命名">
              <PencilSquareIcon class="h-5 w-5" />
            </button>
            <button @click="deleteFile(file)" class="p-1 text-sm text-red-600 hover:text-red-500" title="删除" aria-label="删除">
              <TrashIcon class="h-5 w-5" />
            </button>
            <button @click="clipFile(file)" class="p-1 text-sm text-indigo-600 hover:text-indigo-500" title="剪贴" aria-label="剪贴">
              <ScissorsIcon class="h-5 w-5" />
            </button>
            <button @click="copyFile(file)" class="p-1 text-sm text-indigo-600 hover:text-indigo-500" title="复制" aria-label="复制">
              <DocumentDuplicateIcon class="h-5 w-5" />
            </button>
          </div>

          <!-- 小屏：下载 + 更多 -->
          <div class="flex sm:hidden items-center gap-1">
            <button class="p-1 text-blue-600 hover:text-blue-500" @click="downloadFile(file)" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5" />
            </button>
            <button class="p-1 text-gray-600 hover:text-gray-800" @click.stop="openRowMenu('file', file)" title="更多" aria-label="更多">
              <EllipsisVerticalIcon class="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="text-center py-8">
      <svg class="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
        <path
          d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <h3 class="mt-2 text-sm font-medium text-gray-900">这里空空如也</h3>
      <p class="mt-1 text-sm text-gray-500">拖拽文件/文件夹到此处上传，或使用右上角“上传”按钮。</p>
    </div>

    <!-- 小屏行内操作菜单（底部抽屉，已加图标） -->
    <transition name="fade">
      <div v-if="rowMenuOpen" class="fixed inset-0 z-50 sm:hidden">
        <div class="absolute inset-0 bg-black/30" @click="closeRowMenu"></div>
        <div class="absolute inset-x-0 bottom-0 bg-white rounded-t-2xl p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-xl">
          <div class="mx-auto h-1.5 w-12 rounded bg-gray-300 mb-3"></div>
          <div class="grid grid-cols-4 gap-2 text-center text-xs">
            <!-- 文件动作 -->
            <button
                v-if="rowMenu?.type==='file'"
                class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
                @click="openPreview(rowMenu.item as FileRecord); closeRowMenu()"
                aria-label="预览"
              >
              <EyeIcon class="h-6 w-6 text-gray-700" />
              <span class="mt-1">预览</span>
            </button>
            <button
              v-if="rowMenu?.type==='file'"
              class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
              @click="renameFile(rowMenu.item as FileRecord); closeRowMenu()"
              aria-label="重命名"
            >
              <PencilSquareIcon class="h-6 w-6 text-gray-700" />
              <span class="mt-1">重命名</span>
            </button>
            <button
              v-if="rowMenu?.type==='file'"
              class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
              @click="deleteFile(rowMenu.item as FileRecord); closeRowMenu()"
              aria-label="删除"
            >
              <TrashIcon class="h-6 w-6 text-red-600" />
              <span class="mt-1">删除</span>
            </button>
            <button
              v-if="rowMenu?.type==='file'"
              class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
              @click="clipFile(rowMenu.item as FileRecord); closeRowMenu()"
              aria-label="剪贴"
            >
              <ScissorsIcon class="h-6 w-6 text-indigo-600" />
              <span class="mt-1">剪贴</span>
            </button>
            <button
              v-if="rowMenu?.type==='file'"
              class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
              @click="copyFile(rowMenu.item as FileRecord); closeRowMenu()"
              aria-label="复制"
            >
              <DocumentDuplicateIcon class="h-6 w-6 text-indigo-600" />
              <span class="mt-1">复制</span>
            </button>

            <!-- 文件夹动作 -->
            <button
              v-if="rowMenu?.type==='folder'"
              class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
              @click="renameFolder(rowMenu.item as FolderRecord); closeRowMenu()"
              aria-label="重命名"
            >
              <PencilSquareIcon class="h-6 w-6 text-gray-700" />
              <span class="mt-1">重命名</span>
            </button>
            <button
              v-if="rowMenu?.type==='folder'"
              class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
              @click="deleteFolder(rowMenu.item as FolderRecord); closeRowMenu()"
              aria-label="删除"
            >
              <TrashIcon class="h-6 w-6 text-red-600" />
              <span class="mt-1">删除</span>
            </button>
            <button
              v-if="rowMenu?.type==='folder'"
              class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
              @click="clipFolder(rowMenu.item as FolderRecord); closeRowMenu()"
              aria-label="剪贴"
            >
              <ScissorsIcon class="h-6 w-6 text-indigo-600" />
              <span class="mt-1">剪贴</span>
            </button>
            <button
              v-if="rowMenu?.type==='folder'"
              class="px-2 py-3 rounded hover:bg-gray-50 flex flex-col items-center justify-center"
              @click="copyFolder(rowMenu.item as FolderRecord); closeRowMenu()"
              aria-label="复制"
            >
              <DocumentDuplicateIcon class="h-6 w-6 text-indigo-600" />
              <span class="mt-1">复制</span>
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 小屏底部操作条：有选中时出现 -->
    <transition name="slide-up">
      <div v-show="selectedCount > 0" class="fixed bottom-0 inset-x-0 z-40 sm:hidden bg-white border-t px-3 py-2 pb-[calc(env(safe-area-inset-bottom)+8px)]">
        <div class="flex items-center justify-between">
          <span class="text-sm text-gray-700">已选 {{ selectedCount }} 项</span>
          <div class="flex items-center gap-3">
            <button class="p-1 text-red-600 disabled:opacity-50" :disabled="bulkDeleting" @click="deleteSelected" title="删除" aria-label="删除">
              <TrashIcon class="h-5 w-5"/>
            </button>
            <button class="p-1 text-indigo-600 disabled:opacity-50" :disabled="bulkDownloading" @click="downloadSelected" title="下载" aria-label="下载">
              <ArrowDownTrayIcon class="h-5 w-5"/>
            </button>
            <button class="p-1 text-indigo-600 disabled:opacity-50" :disabled="selectedCount===0" @click="clipSelection" title="剪贴" aria-label="剪贴">
              <ScissorsIcon class="h-5 w-5"/>
            </button>
            <button class="p-1 text-indigo-600 disabled:opacity-50" :disabled="selectedCount===0" @click="copySelection" title="复制" aria-label="复制">
              <DocumentDuplicateIcon class="h-5 w-5"/>
            </button>
            <button class="p-1 text-green-600 disabled:opacity-50" :disabled="!hasClipboard || pasting" @click="pasteClipboard" title="粘贴" aria-label="粘贴">
              <ClipboardDocumentCheckIcon class="h-5 w-5"/>
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 小屏悬浮上传按钮（避免滚回顶部） -->
    <button
      class="fixed sm:hidden bottom-[72px] right-4 h-12 w-12 rounded-full bg-indigo-600 text-white shadow-lg flex items-center justify-center"
      @click.stop="toggleUploadMenu"
      title="上传"
      aria-label="上传"
    >
      <ArrowUpTrayIcon class="h-6 w-6" />
    </button>
    <!-- 全屏文件预览 -->
    <FilePreviewer
      v-if="previewingFile"
      :file="previewingFile"
      :current-folder-id="currentFolderId"
      :target-user-id="targetUserIdRef?.value ?? null"
      @close="closePreview"
      @saved="fetchFiles"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, toRef, watch, computed } from 'vue'
import { formatToUTC8 } from '~~/server/utils/time'
import { useFileBrowser } from '~/composables/useFileBrowser'
import { useDualSelection } from '~/composables/useDualSelection'
import { useBulkActions } from '~/composables/useBulkActions'
import { formatFileSize } from '~/utils/format'
import { useFileUpload } from '~/composables/useFileUpload'
import type { FolderRecord, FileRecord } from '~/types/file-browser'
import { useClipboard } from '~/composables/useClipboard'
import { useUploadMenu } from '~/composables/useUploadMenu'
import { useNameEditing } from '~/composables/useNameEditing'
import { useFolderDownload } from '~/composables/useFolderDownload'
import { useDnDUpload } from '~/composables/useDnDUpload'
import FileIcon from '~/components/FileIcon.vue'
import FilePreviewer from '~/components/FilePreviewer.vue'
import { EyeIcon } from '@heroicons/vue/24/outline'

/* 引入图标 */
import {
  ArrowLeftIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  ScissorsIcon,
  DocumentDuplicateIcon,
  ClipboardDocumentCheckIcon,
  ArrowUpTrayIcon,
  FolderPlusIcon,
  ArrowPathIcon,
  PencilSquareIcon,
  ArrowRightIcon,
  DocumentArrowUpIcon,
  EllipsisVerticalIcon
} from '@heroicons/vue/24/outline'

const props = defineProps<{
  targetUserId?: number | null
  title?: string
}>()
const targetUserIdRef = toRef(props, 'targetUserId')

const previewingFile = ref<FileRecord | null>(null)
const openPreview = (file: FileRecord) => { previewingFile.value = file }
const closePreview = () => { previewingFile.value = null }


// 三态单选与两个布尔变量的映射
const conflictStrategy = computed<'overwrite' | 'skip' | 'rename'>({
  get() {
    if (overwriteExisting.value) return 'overwrite'
    if (skipExisting.value) return 'skip'
    return 'rename'
  },
  set(v) {
    overwriteExisting.value = v === 'overwrite'
    skipExisting.value = v === 'skip'
  }
})

/* 列表/导航 */
const {
  folders, files, loading, hasItems,
  currentFolderId, breadcrumbs,
  fetchFiles, navigateToFolder, goUp, goToBreadcrumb
} = useFileBrowser({ targetUserId: targetUserIdRef })

/* 选择/全选 */
const {
  masterCheckboxRef,
  selectedFolderIds, selectedFileIds,
  selectedCount, isAllSelected,
  toggleSelectAll, toggleSelectFolder, toggleSelectFile,
  clearSelection, reconcileSelection
} = useDualSelection(folders, files)

/* 批量操作&单项文件/文件夹操作 */
const {
  bulkDeleting, bulkDownloading,
  downloadFile, deleteFile, deleteFolder,
  deleteSelected, downloadSelected
} = useBulkActions(folders, files, selectedFolderIds, selectedFileIds, { targetUserId: targetUserIdRef })

/* 上传相关 */
const { uploading, uploadProgress, uploadError, uploadMultipleFiles } = useFileUpload({ targetUserId: targetUserIdRef })

/* 上传悬浮菜单 */
const { showUploadMenu, uploadMenuRef, openUploadMenu, scheduleCloseUploadMenu, toggleUploadMenu } = useUploadMenu()
const closeUploadMenu = () => { showUploadMenu.value = false }

/* 新建/重命名 */
const { createFolder, renameFolder, renameFile } = useNameEditing(
  folders, files, breadcrumbs, currentFolderId, fetchFiles,
  { targetUserId: targetUserIdRef }
)

/* 文件夹打包下载（使用 downloadingFolderId2） */
const { downloadingFolderId: downloadingFolderId2, downloadFolder } = useFolderDownload({ targetUserId: targetUserIdRef })

/* 拖拽/选择上传 */
const {
  isDragging, onDragEnter, onDragLeave,
  fileInputRef, folderInputRef, overwriteExisting,
  handleDrop, handleFileSelect, handleFolderSelect,
  skipExisting
} = useDnDUpload(currentFolderId, uploadMultipleFiles, fetchFiles, clearSelection, { targetUserId: targetUserIdRef })

/* 剪贴板（剪贴/复制/粘贴） */
const {
  clipboard, pasting, hasClipboard, clipboardCount,
  clipboardActionLabel, pasteBtnText,
  clipSelection, copySelection, clipFolder, copyFolder, clipFile, copyFile, pasteClipboard
} = useClipboard(
  { selectedFolderIds, selectedFileIds, selectedCount, currentFolderId, fetchFiles, clearSelection },
  { targetUserId: targetUserIdRef, overwriteExisting, skipExisting}
)

/* 小屏更多菜单状态 */
const mobileMoreOpen = ref(false)

/* 行内“更多”菜单（小屏） */
const rowMenuOpen = ref(false)
const rowMenu = ref<{ type: 'file' | 'folder'; item: FileRecord | FolderRecord } | null>(null)
const openRowMenu = (type: 'file' | 'folder', item: FileRecord | FolderRecord) => {
  rowMenu.value = { type, item }
  rowMenuOpen.value = true
}
const closeRowMenu = () => {
  rowMenuOpen.value = false
  rowMenu.value = null
}

/* 保持选择状态与列表同步 */
watch([folders, files], () => reconcileSelection())

/* 导航封装 */
const handleNavigateToFolder = (folder: FolderRecord) => { clearSelection(); navigateToFolder(folder) }
const handleGoUp = () => { clearSelection(); goUp() }
const handleGoToBreadcrumb = (index: number) => { clearSelection(); goToBreadcrumb(index) }

/* 向父组件暴露/事件 */
const emit = defineEmits<{ 'folder-change': [number | null] }>()
watch(currentFolderId, (id) => emit('folder-change', id), { immediate: true })

defineExpose({
  fetchFiles,
  currentFolderId,
  breadcrumbs
})
</script>

<style scoped>
/* 移动端面包屑隐藏滚动条 */
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

/* 过渡动画 */
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.slide-up-enter-active, .slide-up-leave-active { transition: transform 0.22s ease, opacity 0.22s ease; }
.slide-up-enter-from, .slide-up-leave-to { transform: translateY(8px); opacity: 0; }

.fade-slide-enter-active, .fade-slide-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.fade-slide-enter-from, .fade-slide-leave-to { opacity: 0; transform: translateY(-6px); }
</style>