import { describe, expect, it, vi } from 'vitest'
import { deleteViaRowVue, findBossObject } from './boss-delete'

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
  it('名字核对通过时调用本行 deleteBoss(boss)', () => {
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
