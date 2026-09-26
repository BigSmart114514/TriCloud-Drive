export default defineNuxtPlugin(() => {
  const { hydrate } = useUiPreferences()
  hydrate()
})
