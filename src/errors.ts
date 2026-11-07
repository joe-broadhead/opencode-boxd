export class BoxdError extends Error {
  readonly code: string
  readonly next: string

  constructor(code: string, message: string, next: string) {
    super(message)
    this.name = "BoxdError"
    this.code = code
    this.next = next
  }
}
