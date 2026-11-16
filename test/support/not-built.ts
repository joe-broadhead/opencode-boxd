// A port a test does not use: any member throws, naming it, except `dispose`, which does nothing.

export function notBuilt<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => {
      if (member === "then") return undefined
      if (member === "dispose") return async () => {}
      return () => {
        throw new Error(`${name}.${String(member)} is not part of this test.`)
      }
    },
  })
}
