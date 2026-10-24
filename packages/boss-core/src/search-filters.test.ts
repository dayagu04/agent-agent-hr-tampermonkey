import { afterEach, describe, expect, it, vi } from 'vitest'

const { diag } = vi.hoisted(() => ({ diag: vi.fn() }))
vi.mock('./logger', () => ({ diag }))

import { probeSearchFiltersOnce, readSearchFilters, selectSearchFilter } from './search-filters'

function visibleAll(): void {
  for (const el of Array.from(document.querySelectorAll('*'))) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 60, bottom: 20, width: 60, height: 20, toJSON: () => ({}),
    })
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  diag.mockClear()
})

describe('search filters (read only)', () => {
  it('reads filter groups and notice which options carry URL params', () => {
    document.body.innerHTML = `
      <div class="condition-box">
        <div class="row"><span>城市</span>
          <a href="/web/geek/jobs?query=x&city=101010100" class="active">合肥</a>
          <a href="/web/geek/jobs?query=x&city=101020100">上海</a>
        </div>
        <div class="row"><span>工作经验</span>
          <span role="option">1-3年</span>
          <span role="option">3-5年</span>
        </div>
        <div class="row"><span>薪资待遇</span>
          <span role="option">10-15K</span>
          <span role="option">15-20K</span>
        </div>
      </div>`
    visibleAll()

    const groups = readSearchFilters()
    expect(groups.map((g) => g.name)).toEqual(['城市', '薪资待遇', '工作经验'])
    const city = groups[0]
    expect(city.options.map((o) => o.text)).toEqual(['合肥', '上海'])
    expect(city.options[0].href).toContain('city=101010100')
    expect(city.options[0].selected).toBe(true)
    expect(city.options[1].selected).toBe(false)
    // 不带 href 的组说明只能靠点击，没法用 URL 参数设定
    expect(groups[1].options.every((o) => !o.href)).toBe(true)
  })

  it('logs one summary line per URL, without page copy', () => {
    document.body.innerHTML = `
      <div class="condition-box">
        <div class="row"><span>城市</span>
          <a href="?city=1" class="active">合肥</a><a href="?city=2">上海</a></div>
      </div>`
    visibleAll()
    window.history.replaceState({}, '', '/web/geek/jobs?query=python&city=1')

    probeSearchFiltersOnce('test')
    const line = String(diag.mock.calls.at(-1)?.[1])
    expect(line).toContain('status=found')
    expect(line).toContain('城市:2opt,href=city,sel=1')
    expect(line).toContain('params=city')

    // 同一 URL 不重复刷屏
    probeSearchFiltersOnce('test')
    expect(diag).toHaveBeenCalledTimes(1)
  })

  it('says plainly when the filter bar is not recognized', () => {
    document.body.innerHTML = `<div class="whatever">职位</div>`
    visibleAll()
    window.history.replaceState({}, '', '/web/geek/jobs?query=python')

    probeSearchFiltersOnce('test')
    const line = String(diag.mock.calls.at(-1)?.[1])
    expect(line).toContain('status=none')
    expect(line).toContain('params=-')
  })
})

describe('selecting a filter (click → panel → option)', () => {
  function rects(): void {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if ((el as HTMLElement).getBoundingClientRect().width > 0) continue
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, left: 0, right: 60, bottom: 20, width: 60, height: 20, toJSON: () => ({}),
      })
    }
  }

  it('selects only the requested group and confirms its resulting state', async () => {
    vi.useFakeTimers()
    // 2026-10-25 probe_dom commands 40/42/53: each group owns a hover-only dropdown.
    // Hidden dropdowns have block/hidden/0/auto CSS; li inherits hidden but has opacity 1.
    document.body.innerHTML = `
      <style>
        .filter-select-dropdown { visibility: hidden; opacity: 0; pointer-events: auto; }
        .filter-select-dropdown ul, .filter-select-dropdown li { opacity: 1; }
        .filter-select-dropdown li { cursor: pointer; }
      </style>
      <div class="filter-condition-inner">
        <div class="condition-filter-select" id="salary">
          <div class="current-select"><span class="placeholder-text">薪资待遇</span></div>
          <div class="filter-select-dropdown"><ul>
            <li>不限<i class="ui-icon-check"></i></li><li>10-15K<i class="ui-icon-check"></i></li>
          </ul></div>
        </div>
        <div class="condition-filter-select is-select" id="experience">
          <div class="current-select"><span class="placeholder-text">工作经验</span><em class="select-num">(1)</em></div>
          <div class="filter-select-dropdown"><ul>
            <li>不限<i class="ui-icon-check"></i></li><li class="active">3-5年<i class="ui-icon-check"></i></li>
          </ul></div>
        </div>
      </div>`
    rects()
    window.history.replaceState({}, '', '/web/geek/jobs?query=test&experience=105')
    const group = document.querySelector('#experience') as HTMLElement
    const panel = group.querySelector('.filter-select-dropdown') as HTMLElement
    // command 76: computed panel visibility/opacity stay hidden/0 after inline writes.
    // jsdom has no transition engine, so retain that computed state until this panel's transition is disabled.
    panel.style.setProperty('transition-duration', '4s', 'important')
    const originalComputedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const actual = originalComputedStyle(el, pseudo)
      if (el !== panel || panel.style.getPropertyValue('transition') === 'none') return actual
      return new Proxy(actual, {
        get(style, property) {
          if (property === 'visibility') return 'hidden'
          if (property === 'opacity') return '0'
          const value = Reflect.get(style, property, style)
          return typeof value === 'function' ? value.bind(style) : value
        },
      })
    })
    const salaryClick = vi.fn()
    document.querySelector('#salary li')!.addEventListener('click', salaryClick)
    const selectedOptions: string[] = []
    panel.addEventListener('click', (event) => {
      const li = (event.target as Element).closest('li')
      if (!li) return
      selectedOptions.push(li.textContent || '')
      if (li.textContent === '不限') {
        panel.querySelector('.active')?.classList.remove('active')
        group.classList.remove('is-select')
        group.querySelector('.select-num')?.remove()
        window.history.replaceState({}, '', '/web/geek/jobs?query=test')
      } else {
        // A click and an unrelated URL update are insufficient confirmation.
        window.history.replaceState({}, '', '/web/geek/jobs?query=test&city=1')
      }
    })

    const clearing = selectSearchFilter('工作经验', '不限')
    await vi.runAllTimersAsync()
    expect(await clearing).toMatchObject({ status: 'ok', urlChanged: true })
    expect(selectedOptions).toEqual(['不限'])
    expect(salaryClick).not.toHaveBeenCalled()
    expect(panel.style.getPropertyValue('visibility')).toBe('')
    expect(panel.style.getPropertyValue('opacity')).toBe('')
    expect(panel.style.getPropertyValue('transition')).toBe('')
    expect(panel.style.getPropertyValue('transition-duration')).toBe('4s')
    expect(panel.style.getPropertyPriority('transition-duration')).toBe('important')
    expect(getComputedStyle(panel).visibility).toBe('hidden')
    expect(readSearchFilters().find((g) => g.name === '工作经验')?.options.some((o) => o.selected)).toBe(false)

    expect(await selectSearchFilter('工作经验', '不限')).toMatchObject({ status: 'ok', urlChanged: false })
    expect(selectedOptions).toEqual(['不限'])

    const ignored = selectSearchFilter('工作经验', '3-5年')
    await vi.runAllTimersAsync()
    expect(await ignored).toMatchObject({ status: 'selection_not_confirmed', urlChanged: true })
    expect(selectedOptions).toEqual(['不限', '3-5年'])
    expect(salaryClick).not.toHaveBeenCalled()

    // A separately hidden or disabled li must remain unavailable after expanding its dropdown.
    const experienceOption = panel.querySelectorAll('li')[1] as HTMLElement
    experienceOption.style.visibility = 'hidden'
    const independentlyHidden = selectSearchFilter('工作经验', '3-5年')
    await vi.runAllTimersAsync()
    expect(await independentlyHidden).toMatchObject({
      status: 'no_panel', urlChanged: false,
      diagnostic: {
        stage: 'expand_timeout',
        panelInlineAfter: {
          visibility: { present: true, matchesExpected: true, important: true },
          opacity: { present: true, matchesExpected: true, important: true },
          transition: { present: true, matchesExpected: true, important: true },
        },
      },
    })
    experienceOption.style.removeProperty('visibility')
    experienceOption.setAttribute('aria-disabled', 'true')
    const disabled = selectSearchFilter('工作经验', '3-5年')
    await vi.runAllTimersAsync()
    expect(await disabled).toMatchObject({ status: 'no_panel', urlChanged: false })
    expect(selectedOptions).toEqual(['不限', '3-5年'])
    expect(panel.style.getPropertyValue('visibility')).toBe('')
    expect(panel.style.getPropertyValue('opacity')).toBe('')
    expect(panel.style.getPropertyValue('transition')).toBe('')
    expect(panel.style.getPropertyValue('transition-duration')).toBe('4s')
    expect(panel.style.getPropertyPriority('transition-duration')).toBe('important')
  })

  it('stops and says why when the group label is missing', async () => {
    document.body.innerHTML = `<div class="filter-bar"><span>城市</span></div>`
    rects()
    const r = await selectSearchFilter('工作经验', '3-5年')
    expect(r.status).toBe('no_trigger')
    expect(String(diag.mock.calls.at(-1)?.[1])).toContain('status=no_trigger')
  })
})
