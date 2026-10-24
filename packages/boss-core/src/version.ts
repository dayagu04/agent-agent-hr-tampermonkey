// 各宿主构建注入自己的版本：MV3 来自 apps/boss-agent，历史入口来自 legacy 构建。
declare const __AAH_BOSS_VERSION__: string

/** 三段式版本号（major.minor.patch）。 */
export const VERSION: string = __AAH_BOSS_VERSION__
export const VERSION_LABEL = `v${VERSION}`
