// A scriptable runtime for contract tests (coordinator.test.ts) and future adapter conformance fixtures (R11d): the
// test drives it through its host the way a real runtime would (events, tool calls, questions, failure).
import type { AgentRuntimeCapabilities, AgentRuntimeProbe } from "../../../shared/types"
import { answerQuestion as answerPendingQuestion } from "../questions"
import type { AdapterHost, AgentAdapter, AgentRuntime, AgentSessionContext, AgentTurnInput } from "./types"

export const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  images: true,
  streaming: true,
  appTools: true,
  userQuestions: true,
  permissionRequests: false,
  resume: true,
  fork: true,
  modelSwitch: true,
  usage: "tokens",
  isolation: { workspaceWrites: false, network: false },
}

export class FakeAdapter implements AgentAdapter {
  ctx!: AgentSessionContext
  sent: AgentTurnInput[] = []
  interrupts = 0
  closed = false
  models: string[] = []
  private _alive = false
  /** What interrupt() does; default: end the run as interrupted. */
  onInterrupt: () => void = () => this.host.emit({ type: "run.interrupted" }, { itemId: `end:${this.interrupts}` })

  constructor(readonly host: AdapterHost) {}

  get alive() {
    return this._alive
  }
  async start(ctx: AgentSessionContext) {
    this.ctx = ctx
    this._alive = true
    return { nativeSessionId: ctx.sessionId }
  }
  send(input: AgentTurnInput) {
    this.sent.push(input)
  }
  answerQuestion(requestId: string, answers: Record<string, string>, notes?: Record<string, string>) {
    answerPendingQuestion(this.ctx.projectId, requestId, answers, notes)
  }
  answerPermission(): void {
    throw new Error("no permission requests")
  }
  async interrupt() {
    this.interrupts++
    this.onInterrupt()
  }
  async setModel(model: string) {
    this.models.push(model)
  }
  close() {
    this.closed = true
    this._alive = false
  }
  /** The runtime process dies (or ends). */
  die(error?: string) {
    this._alive = false
    this.host.ended({ error })
  }
}

export class FakeRuntime implements AgentRuntime {
  /** A second kind ("fake2") stands in for another runtime in handoff tests. */
  constructor(readonly kind: string = "fake") {}
  readonly capabilities = FAKE_CAPABILITIES
  adapters: FakeAdapter[] = []
  forks: string[] = []
  get last(): FakeAdapter {
    return this.adapters[this.adapters.length - 1]
  }
  async probe(): Promise<AgentRuntimeProbe> {
    return { runtime: this.kind, installed: true, version: "0", auth: { method: "none", status: "ok" }, models: [], capabilities: FAKE_CAPABILITIES }
  }
  create(host: AdapterHost) {
    const a = new FakeAdapter(host)
    this.adapters.push(a)
    return a
  }
  async fork(nativeSessionId: string) {
    this.forks.push(nativeSessionId)
    return { nativeSessionId: `${nativeSessionId}-fork${this.forks.length}` }
  }
}
