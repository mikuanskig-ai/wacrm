/**
 * Thin wrapper around a real delay so `dispatchInboundToAiReply`'s
 * message-settle debounce (see there for why) can be mocked to
 * resolve instantly in tests, instead of every test in the suite
 * paying the real wall-clock delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
