/** Tiny value cache. Seeded bug: a missing key throws instead of returning undefined. */
export class ValueCache {
  constructor() {
    this.entries = new Map()
  }

  set(key, value) {
    this.entries.set(key, { value, at: Date.now() })
  }

  get(key) {
    return this.entries.get(key).value
  }
}
