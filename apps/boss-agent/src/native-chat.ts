import { nativePageCall, nativePageContext, nativeSend } from './host-bridge'
import { diag } from '../../../packages/boss-core/src/logger'
import { installChatDriver } from '../../../packages/boss-core/src/platforms/chat-driver'
import type { ChatCurrent, ChatDriver, ChatSourceItem } from '../../../packages/boss-core/src/platforms/chat-driver'

const emptyCurrent = (): ChatCurrent => ({ threadId: '', info: { company: '', hrName: '', jobTitle: '', salary: '', city: '' } })

/** Installs the same conversation runner used by the userscript, with document operations in MAIN. */
export function installNativeChatDriver(): void {
  let current = emptyCurrent()
  let sources: ChatSourceItem[] | null = null
  let contextUrl = nativePageContext().url
  const context = () => {
    const next = nativePageContext()
    if (next.url !== contextUrl) {
      contextUrl = next.url
      current = emptyCurrent()
      sources = null
    }
    return next
  }
  const driver: ChatDriver = {
    onChatPage: () => /\/web\/geek\/chat(?:[/?#]|$)/.test(context().url),
    stop: () => { void nativeSend('boss.panel.cancel').catch(() => diag('CHAT', '页面取消请求未确认，后续动作已停止')) },
    cachedCurrent: () => { context(); return current },
    cachedSources: () => { context(); return sources },
    snapshot: () => nativePageCall('chat.snapshot'),
    sources: async () => { sources = await nativePageCall('chat.sources'); return sources },
    window: (screen) => nativePageCall('chat.window', screen === undefined ? {} : { screen }),
    open: async (target) => {
      current = emptyCurrent()
      const opened = await nativePageCall<ChatCurrent | null>('chat.open', { target })
      if (opened) current = opened
      return opened
    },
    current: async () => { current = await nativePageCall('chat.current'); return current },
    messages: (expectedThread) => nativePageCall('chat.messages', { expectedThread }),
    cards: (expectedThread) => nativePageCall('chat.cards', { expectedThread }),
    card: (action, key) => nativePageCall('chat.card', { ...action }, key),
    send: (text, expectedThread, key) => nativePageCall('chat.send', { text, expectedThread }, key),
    resume: (resumeName, expectedThread, key) => nativePageCall('chat.resume', { resumeName, expectedThread }, key),
    delete: async (action, key) => {
      const deleted = await nativePageCall<boolean>('chat.delete', { ...action }, key)
      if (deleted) { current = emptyCurrent(); sources = null }
      return deleted
    },
  }
  installChatDriver(driver)
}
