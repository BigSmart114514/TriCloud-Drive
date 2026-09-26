import { refreshLiquidGlass, setupLiquidGlass, teardownLiquidGlass } from '~/utils/liquidGlass'

export default defineNuxtPlugin((nuxtApp) => {
  const sync = () => {
    if (document.documentElement.dataset.ui === 'experimental') setupLiquidGlass()
    else teardownLiquidGlass()
  }

  nuxtApp.hook('app:mounted', () => {
    sync()
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui']
    })
  })

  nuxtApp.hook('page:finish', () => {
    if (document.documentElement.dataset.ui === 'experimental') refreshLiquidGlass()
  })
})
