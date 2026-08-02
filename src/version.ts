// 版本号唯一真相源。
//
// 为什么单独一个模块：版本号此前散在三处（package.json / vite.config.ts 的
// userscript header / App.vue 的两个显示位），实测已经漂成三个不同的值
// （0.3.0 / 0.1.0 / 0.2.0）—— 用户据此判断"是不是装错版本了"，漂了就失去意义。
// 现在全部从 package.json 读，改版本只需改那一处。
import pkg from '../package.json'

/** 三段式版本号（major.minor.patch），如 "0.3.1" */
export const VERSION: string = pkg.version

/** 带 v 前缀的展示用版本号，如 "v0.3.1" */
export const VERSION_LABEL = `v${VERSION}`
