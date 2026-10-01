// localStorage 内存实现，需在引入 store 前加载
const map = new Map<string, string>()

class MemoryStorage {
  get length(): number {
    return map.size
  }

  getItem(key: string): string | null {
    return map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    map.set(key, String(value))
  }

  removeItem(key: string): void {
    map.delete(key)
  }

  clear(): void {
    map.clear()
  }

  key(index: number): string | null {
    return [...map.keys()][index] ?? null
  }
}

const g = globalThis as Record<string, unknown>
g.localStorage = new MemoryStorage()
g.Storage = MemoryStorage

// Node 的 structuredClone 无法克隆 Vue 响应式 Proxy（浏览器可以），测试环境回退为 JSON 深拷贝
const nativeClone = g.structuredClone as (value: unknown) => unknown
g.structuredClone = (value: unknown): unknown => {
  try {
    return nativeClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}
