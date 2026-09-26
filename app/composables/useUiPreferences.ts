export const UI_PREFERENCES_STORAGE_KEY = 'tricloud.ui-preferences'
export const EXPERIMENTAL_UI_MODE = 'experimental'

export interface UiPreferences {
  experimentalUi: boolean
}

const defaultPreferences = (): UiPreferences => ({ experimentalUi: false })

const readPreferences = (): UiPreferences => {
  if (!import.meta.client) return defaultPreferences()
  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY)
    if (!raw) return defaultPreferences()
    const parsed = JSON.parse(raw) as Partial<UiPreferences> | null
    return { experimentalUi: parsed?.experimentalUi === true }
  } catch {
    return defaultPreferences()
  }
}

const writePreferences = (preferences: UiPreferences) => {
  if (!import.meta.client) return
  try {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // 隐私模式或存储被禁用时忽略
  }
}

const applyUiMode = (experimentalUi: boolean) => {
  if (!import.meta.client) return
  const root = document.documentElement
  if (experimentalUi) root.dataset.ui = EXPERIMENTAL_UI_MODE
  else delete root.dataset.ui
}

export const useUiPreferences = () => {
  const preferences = useState<UiPreferences>('ui-preferences', defaultPreferences)

  const experimentalUi = computed({
    get: () => preferences.value.experimentalUi,
    set: (value: boolean) => {
      preferences.value = { ...preferences.value, experimentalUi: value }
      writePreferences(preferences.value)
      applyUiMode(value)
    }
  })

  const hydrate = () => {
    const stored = readPreferences()
    preferences.value = stored
    applyUiMode(stored.experimentalUi)
  }

  return { preferences, experimentalUi, hydrate }
}
