import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  absolutizeLink,
  decodeEntities,
  extractArticleText,
  extractRealUrl,
  extractSearchResults,
  isAntiSpider,
  stripTags,
} from '../src/parse.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
}

describe('decodeEntities', () => {
  it('解码常见命名实体', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;&#39;&nbsp;')).toBe('&<>"\'\' ')
  })

  it('解码中文排版实体', () => {
    expect(decodeEntities('&ldquo;引号&rdquo;&lsquo;单引号&rsquo;&mdash;&middot;&hellip;&ndash;'))
      .toBe('“引号”‘单引号’—·…–')
  })

  it('解码十进制与十六进制数字实体', () => {
    expect(decodeEntities('&#65;&#x42;')).toBe('AB')
  })

  it('未识别的命名实体原样保留', () => {
    expect(decodeEntities('&unknownEntity;')).toBe('&unknownEntity;')
  })

  it('超出 Unicode 范围的数字实体替换为 U+FFFD 而非抛异常', () => {
    expect(() => decodeEntities('&#x110000;&#999999999999;')).not.toThrow()
    expect(decodeEntities('&#x110000;&#999999999999;')).toBe('��')
  })

  it('代理区数字实体按 HTML5 规范替换为 U+FFFD', () => {
    expect(decodeEntities('&#xD800;&#xDFFF;')).toBe('��')
  })
})

describe('stripTags', () => {
  it('移除所有标签只保留文本', () => {
    expect(stripTags('<p>你好<strong>世界</strong></p>')).toBe('你好世界')
  })
})

describe('isAntiSpider', () => {
  it('finalUrl 含 antispider 判定为拦截', () => {
    expect(isAntiSpider('正常内容', 'https://weixin.sogou.com/antispider/?from=x')).toBe(true)
  })

  it('响应体含 seccoderight 判定为拦截', () => {
    expect(isAntiSpider('<div id="seccodeRight">验证</div>', 'https://weixin.sogou.com/weixin')).toBe(true)
  })

  it('响应体含 anti.min.css 判定为拦截', () => {
    expect(isAntiSpider('<link href="/anti.min.css">', 'https://weixin.sogou.com/weixin')).toBe(true)
  })

  it('正常响应不判定为拦截', () => {
    expect(isAntiSpider('<div>正常搜索结果</div>', 'https://weixin.sogou.com/weixin?query=test')).toBe(false)
  })

  it('使用真实反爬 fixture 判定为拦截', () => {
    const html = fixture('search-page-antispider.html')
    expect(isAntiSpider(html, 'https://weixin.sogou.com/antispider/?from=weixin')).toBe(true)
  })
})

describe('extractSearchResults', () => {
  it('按出现顺序配对标题与发布时间,标题文本去标签并解码实体', () => {
    const html = fixture('search-page.html')
    const rows = extractSearchResults(html)
    expect(rows).toHaveLength(3)

    expect(rows[0]).toEqual({
      title: '公众号测试文章标题一 & 特辑',
      link: '/link?url=abc123',
      publish_time: '2024-01-01',
    })
    expect(rows[1]).toEqual({
      title: '测试文章标题二<完整版>',
      link: 'https://weixin.sogou.com/link?url=def456',
      publish_time: '2024-02-15',
    })
    expect(rows[2]).toEqual({
      title: '测试文章标题三 完',
      link: '/link?url=ghi789',
      publish_time: '2024-03-20',
    })
  })

  it('未匹配到标题节点时返回空数组', () => {
    expect(extractSearchResults('<div>没有结果</div>')).toEqual([])
  })
})

describe('absolutizeLink', () => {
  it('http(s) 开头的链接原样返回', () => {
    expect(absolutizeLink('https://weixin.sogou.com/link?url=x')).toBe('https://weixin.sogou.com/link?url=x')
    expect(absolutizeLink('http://weixin.sogou.com/link?url=x')).toBe('http://weixin.sogou.com/link?url=x')
  })

  it('非 http 开头的链接拼接 weixin.sogou.com 前缀', () => {
    expect(absolutizeLink('/link?url=abc123')).toBe('https://weixin.sogou.com/link?url=abc123')
  })

  it('非搜狗域的绝对链接返回空串(防会话 cookie 外泄)', () => {
    expect(absolutizeLink('https://evil.example.com/link?url=x')).toBe('')
    expect(absolutizeLink('https://weixin.sogou.com.evil.com/link')).toBe('')
    expect(absolutizeLink('https://weixin.sogou.com:8080/link?url=x')).toBe('')
    expect(absolutizeLink('https://[invalid')).toBe('')
  })
})

describe('extractRealUrl', () => {
  it('拼接多段 url += 片段并剔除 @ 干扰符', () => {
    const html = fixture('link-redirect.html')
    expect(extractRealUrl(html)).toBe(
      'https://mp.weixin.qq.com/s?__biz=MjM5NDgwNTE1MQ==&mid=22441122&idx=1&sn=abc123def456',
    )
  })

  it('没有 url += 片段时返回空串', () => {
    expect(extractRealUrl('<script>var x = 1;</script>')).toBe('')
  })

  it('拼接结果去除 @ 后为空时返回空串', () => {
    expect(extractRealUrl('url += \'@@@\';')).toBe('')
  })

  it('新版跳转页拼出完整 URL 时不再叠加 https://mp. 前缀', () => {
    const html = fixture('link-redirect-full.html')
    expect(extractRealUrl(html)).toBe(
      'https://mp.weixin.qq.com/s?src=11&timestamp=1787792205&ver=6929&signature=abc123def456',
    )
  })
})

describe('extractSearchResults 的 timeConvert 时间戳', () => {
  it('将 document.write(timeConvert(...)) 归一化为 YYYY-MM-DD', () => {
    const html =
      '<a id="sogou_vr_11002601_title_0" href="/link?url=x">标题</a>' +
      '<span class="s2">document.write(timeConvert(\'1787785265\'))</span>'
    const rows = extractSearchResults(html)
    expect(rows[0]?.publish_time).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('非 timeConvert 形式的时间文本原样保留', () => {
    const html =
      '<a id="sogou_vr_11002601_title_0" href="/link?url=x">标题</a>' +
      '<span class="s2">2024-01-01</span>'
    expect(extractSearchResults(html)[0]?.publish_time).toBe('2024-01-01')
  })
})

describe('extractArticleText', () => {
  it('按块级标签换行、去标签、解码实体并过滤空行', () => {
    const html = fixture('article.html')
    const text = extractArticleText(html)
    const lines = text.split('\n')

    expect(lines).toEqual([
      '第一段 加粗内容 结束。',
      '第二段包含 “引号” 与 — 破折号。',
      '嵌套小节内容 测试。',
      '换行',
      '之后的内容',
      '列表项一',
      '列表项二',
    ])
  })

  it('未找到 js_content 容器时返回空串', () => {
    expect(extractArticleText('<div>没有正文</div>')).toBe('')
  })

  it('在多个哨兵中选取最早出现的位置截断', () => {
    const html = '<div id="js_content"><p>正文内容</p></div>'
      + '<div class="rich_media_tool">工具栏</div>'
      + '<div id="js_tags">标签</div>'
    expect(extractArticleText(html)).toBe('正文内容')
  })
})
