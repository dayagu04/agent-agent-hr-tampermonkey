import { describe, expect, it, vi } from 'vitest'

// DOM 契约使用未登录的宿主配置快照。
vi.mock('../platform-bridge', () => ({
  configuration: { get: (_key: string, fallback: string) => fallback, set: vi.fn() },
}))
vi.mock('../logger', () => ({ diag: vi.fn() }))
import { deleteViaRowVue, findBossObject } from './boss-delete'
import { deleteThread } from './boss-chat'

describe('findBossObject', () => {
  it('只认带 securityId 的 boss 对象', () => {
    expect(findBossObject({ boss: { name: '张三' } })).toBeNull()
    expect(findBossObject({ friend: { securityId: 's1', name: '李四' } })?.path).toBe('friend')
  })

  it('只搜自己的 data/$props/$attrs，不爬 $parent（防拿 currentBoss 删错人）', () => {
    const vm = {
      boss: { securityId: 'row', name: '张三' },
      $parent: {
        currentBoss: { securityId: 'parent', name: '李四' },
        list: [{ securityId: 'list', name: '王五' }],
      },
    }
    const found = findBossObject(vm)
    expect(found?.obj.securityId).toBe('row')
    expect(found?.path).toBe('boss')
  })

  it('$props 里的对象也能找到', () => {
    const vm = { $props: { item: { securityId: 's2', name: '赵六' } } }
    const found = findBossObject(vm)
    expect(found?.obj.securityId).toBe('s2')
    expect(found?.path).toBe('$props.item')
  })
})

describe('deleteViaRowVue', () => {
  it('只删除唯一且身份已确认的本行，并回报该目标而非公司首条', async () => {
    const deleteBoss = vi.fn()
    const row = document.createElement('li')
    row.innerHTML = '<div class="last-msg">张三 测试公司 招聘主管</div>'
    const host = row.querySelector('.last-msg') as HTMLElement
    ;(host as unknown as { __vue__: unknown }).__vue__ = {
      boss: { securityId: 's1', name: '张三' },
      deleteBoss,
    }

    expect(deleteViaRowVue(row)).toBe(true)
    expect(deleteBoss).toHaveBeenCalledTimes(1)
    expect(deleteBoss).toHaveBeenCalledWith(expect.objectContaining({ securityId: 's1' }))

    // Same measured row/header structure as the existing thread-matching contract.
    document.body.innerHTML = `<ul class="user-list">
      <li data-user-id="target"><span class="name-box"><span class="name-text">陈女士</span>新会话公司...</span></li>
      <li data-user-id="other"><span class="name-box"><span class="name-text">另一位女士</span>新会话公司...</span></li>
    </ul><section id="header"><span class="name-text">其他女士</span><span class="company">其他公司</span><span class="position-name">其他岗位</span></section>`
    const rows = Array.from(document.querySelectorAll('li'))
    const targetBoss = { securityId: 'target', uniqueId: 'target', encryptJobId: 'actual-job', name: '陈女士', brandName: '新会话公司...', positionName: '' }
    const otherBoss = { ...targetBoss, securityId: 'other', uniqueId: 'other', encryptJobId: 'other-job', name: '另一位女士' }
    const sources = [targetBoss, otherBoss]
    const listVm = { $options: { name: 'virtual-list' }, $props: { dataSources: sources } }
    const select = vi.fn()
    const remove = vi.fn(() => { rows[0].remove(); sources.splice(sources.indexOf(targetBoss), 1) })
    const wrongRemove = vi.fn()
    Object.assign(rows[0], { scrollIntoView: vi.fn(), __vue__: { boss: targetBoss, handleClick: select, deleteBoss: remove, $parent: listVm } })
    Object.assign(rows[1], { scrollIntoView: vi.fn(), __vue__: { boss: otherBoss, deleteBoss: wrongRemove, $parent: listVm } })
    const afterDeleted = vi.fn(async () => {})
    const pointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    vi.spyOn(document.querySelector('#header .company')!, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 0, top: 0, left: 100, right: 300, bottom: 40, width: 200, height: 40, toJSON: () => ({}),
    })
    vi.useFakeTimers()
    try {
      expect(await deleteThread('新会话公司', '客服', undefined, afterDeleted)).toBe('failed')
      // Even a second unrendered candidate must prevent a company-only deletion.
      rows[1].remove()
      expect(await deleteThread('新会话公司', '', undefined, afterDeleted)).toBe('failed')
      document.querySelector('.user-list')!.appendChild(rows[1])
      otherBoss.brandName = '其他公司'
      rows[1].querySelector('.name-box')!.innerHTML = '<span class="name-text">另一位女士</span>其他公司'
      for (const identity of [{ bossId: 'missing' }, { encryptJobId: 'missing' }, { bossId: 'other', encryptJobId: 'actual-job' }]) {
        expect(await deleteThread('新会话公司', '客服', identity, afterDeleted)).toBe('not-found')
      }
      expect(remove).not.toHaveBeenCalled()
      expect(wrongRemove).not.toHaveBeenCalled()
      expect(afterDeleted).not.toHaveBeenCalled()
      targetBoss.positionName = '客服主管'
      expect(await deleteThread('新会话公司', '客服', undefined, afterDeleted)).toBe('not-found')
      targetBoss.positionName = ''

      // A stale/wrong job header never authorizes deletion of an unknown-job row.
      const stale = deleteThread('新会话公司', '客服', undefined, afterDeleted)
      await vi.runAllTimersAsync()
      expect(await stale).toBe('failed')
      expect(remove).not.toHaveBeenCalled()

      select.mockImplementationOnce(() => { setTimeout(() => {
        document.querySelector('#header .company')!.textContent = '新会话公司...'
        document.querySelector('#header .name-text')!.textContent = '陈女士'
        document.querySelector('#header .position-name')!.textContent = '客服'
      }, 400) })
      const recycled = deleteThread('新会话公司', '客服', undefined, afterDeleted)
      await vi.advanceTimersByTimeAsync(200)
      expect(remove).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      rows[0].setAttribute('data-user-id', 'recycled')
      await vi.runAllTimersAsync()
      expect(await recycled).toBe('failed')
      expect(remove).not.toHaveBeenCalled()
      rows[0].setAttribute('data-user-id', 'target')
      // Reusing an already matching header remains valid; no new transition is required.
      const deletion = deleteThread('新会话公司', '客服', undefined, afterDeleted)
      await vi.runAllTimersAsync()
      expect(await deletion).toBe('ok')
      expect(remove).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledWith(targetBoss)
      expect(wrongRemove).not.toHaveBeenCalled()
      expect(afterDeleted).toHaveBeenCalledExactlyOnceWith({
        company: '新会话公司', jobTitle: '客服', bossId: 'target', encryptJobId: 'actual-job',
      })
      expect(document.querySelectorAll('.user-list li')).toHaveLength(1)

      // Explicit ID selects the stable row even when its label is stale, but it
      // must still confirm the requested header and report that actual identity.
      document.querySelector('.user-list')!.prepend(rows[0])
      sources.unshift(targetBoss)
      targetBoss.positionName = '网络客服'
      expect(await deleteThread('其他公司', '客服', { encryptJobId: 'actual-job' }, afterDeleted)).toBe('failed')
      sources.push({ ...targetBoss, uniqueId: 'same-person', encryptJobId: 'another-job' })
      expect(await deleteThread('新会话公司', '客服', { encryptJobId: 'actual-job' }, afterDeleted)).toBe('failed')
      sources.pop()
      document.querySelector('#header .position-name')!.textContent = '网络客服'
      const wrongHeader = deleteThread('新会话公司', '客服', { encryptJobId: 'actual-job' }, afterDeleted)
      await vi.runAllTimersAsync()
      expect(await wrongHeader).toBe('failed')
      expect(remove).toHaveBeenCalledTimes(1)
      document.querySelector('#header .position-name')!.textContent = '客服'
      const confirmation = document.createElement('section')
      confirmation.innerHTML = '确认删除吗？<button>确定</button>'
      const finalConfirm = vi.fn()
      confirmation.querySelector('button')!.addEventListener('click', finalConfirm)
      for (const element of [confirmation, confirmation.querySelector('button')!]) {
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 60, top: 60, left: 100, right: 220, bottom: 100, width: 120, height: 40, toJSON: () => ({}) })
      }
      const promptDelete = vi.fn(() => {
        document.body.appendChild(confirmation)
        setTimeout(() => { document.querySelector('#header .position-name')!.textContent = '其他岗位' }, 100)
      })
      Object.assign(rows[0], { __vue__: { boss: targetBoss, handleClick: select, deleteBoss: promptDelete, $parent: listVm } })
      const switchedBeforeConfirm = deleteThread('新会话公司', '客服', { encryptJobId: 'actual-job' }, afterDeleted)
      await vi.runAllTimersAsync()
      expect(await switchedBeforeConfirm).toBe('failed')
      expect(promptDelete).toHaveBeenCalledTimes(1)
      expect(finalConfirm).not.toHaveBeenCalled()
      expect(remove).toHaveBeenCalledTimes(1)
      confirmation.remove()
      document.querySelector('#header .position-name')!.textContent = '客服'
      Object.assign(rows[0], { __vue__: { boss: targetBoss, handleClick: select, deleteBoss: remove, $parent: listVm } })
      const identified = deleteThread('新会话公司', '客服', { encryptJobId: 'actual-job' }, afterDeleted)
      await vi.runAllTimersAsync()
      expect(await identified).toBe('ok')
      expect(remove).toHaveBeenCalledTimes(2)
      expect(afterDeleted).toHaveBeenLastCalledWith({ company: '新会话公司', jobTitle: '客服', bossId: 'target', encryptJobId: 'actual-job' })

      // The header fallback also uses all three identity fields. HR text is
      // deliberately separate from the company, as on the measured BOSS page.
      document.querySelector('.user-list')!.prepend(rows[0])
      sources.unshift(targetBoss)
      targetBoss.positionName = '客服'
      Object.assign(rows[0], { __vue__: { boss: targetBoss, handleClick: select, $parent: listVm } })
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
      rows[0].insertAdjacentHTML('beforeend', '<span class="user-operation"></span>')
      document.querySelector('#header')!.insertAdjacentHTML('beforeend', '<span id="delete" style="opacity:1">删除</span>')
      const headerDelete = document.querySelector('#delete')!
      vi.spyOn(headerDelete, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 40, top: 40, left: 100, right: 160, bottom: 60, width: 60, height: 20, toJSON: () => ({}),
      })
      headerDelete.addEventListener('click', remove)
      const fallback = deleteThread('新会话公司', '客服', undefined, afterDeleted)
      await vi.runAllTimersAsync()
      expect(await fallback).toBe('ok')
      expect(remove).toHaveBeenCalledTimes(3)
      expect(afterDeleted).toHaveBeenCalledTimes(3)
      expect(wrongRemove).not.toHaveBeenCalled()

      document.querySelector('.user-list')!.prepend(rows[0])
      sources.unshift(targetBoss)
      ;(headerDelete as HTMLElement).style.visibility = 'hidden'
      document.querySelector('#header')!.insertAdjacentHTML('beforeend', '<span id="more" style="opacity:1">更多</span>')
      const more = document.querySelector('#more')!
      vi.spyOn(more, 'getBoundingClientRect').mockReturnValue({
        x: 170, y: 40, top: 40, left: 170, right: 190, bottom: 60, width: 20, height: 20, toJSON: () => ({}),
      })
      more.addEventListener('click', () => { setTimeout(() => {
        document.querySelector('#header .position-name')!.textContent = '其他岗位'
        ;(headerDelete as HTMLElement).style.visibility = 'visible'
      }, 100) })
      const changedWhileOpening = deleteThread('新会话公司', '客服', { encryptJobId: 'actual-job' }, afterDeleted)
      await vi.runAllTimersAsync()
      expect(await changedWhileOpening).toBe('failed')
      expect(remove).toHaveBeenCalledTimes(3)
      expect(afterDeleted).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
      if (pointDescriptor) Object.defineProperty(document, 'elementFromPoint', pointDescriptor)
      else Reflect.deleteProperty(document, 'elementFromPoint')
      document.body.innerHTML = ''
    }
  })

  it('boss 对象名字不在本行文本里 → 放弃（防删错）', () => {
    const deleteBoss = vi.fn()
    const row = document.createElement('li')
    row.innerHTML = '<div class="last-msg">李四 另一家公司</div>'
    const host = row.querySelector('.last-msg') as HTMLElement
    ;(host as unknown as { __vue__: unknown }).__vue__ = {
      boss: { securityId: 's1', name: '张三' },
      deleteBoss,
    }

    expect(deleteViaRowVue(row)).toBe(false)
    expect(deleteBoss).not.toHaveBeenCalled()
  })

  it('组件上没有 deleteBoss 方法时返回 false', () => {
    const row = document.createElement('li')
    row.innerHTML = '<div class="last-msg">张三</div>'
    expect(deleteViaRowVue(row)).toBe(false)
  })
})
