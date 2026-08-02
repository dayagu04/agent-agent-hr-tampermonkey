// 版本号唯一真相源：全部从 package.json 读取，改版本只需改那一处。
import pkg from '../package.json'

/** 三段式版本号（major.minor.patch），如 "0.3.1" */
export const VERSION: string = pkg.version

/** 带 v 前缀的展示用版本号，如 "v0.4.20" */
export const VERSION_LABEL = `v${VERSION}`
