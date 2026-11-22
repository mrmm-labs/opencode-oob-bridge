/** What a connector and the approval engine say to each other. */
import type { Decision, Factor } from "./sign.ts"

export type ChannelCaps = {
  buttons: boolean
  /** Whether the channel tells us who answered. */
  approver: "verified" | "none"
  /** Whether it can receive a typed code. */
  replyText: boolean
}

/** What a channel shows about a request. Already masked. */
export type ApprovalView = {
  id: string
  short: string
  nonce: string
  caller: string
  requester: { session_id?: string; agent?: string; tool?: string }
  action_class: string
  level: number
  scope: string
  reason: string
  expiresAt: number
  /** Set on a view that asks for a code only. */
  code?: boolean
  /** The factors on offer, in order, on the prompt for a second factor. */
  factors?: Factor[]
}

export type Settled = {
  decision: Decision
  level: number
  reason?: string
  /** Who answered. */
  by?: string
}

export type TapResult = { ok: boolean; text: string; next?: "code" }

type Res = { status: number; body: unknown }

/** What the Mini App's routes call: the second factor of a request, and enrolment. */
export interface AppApprovals {
  appView(id: string): Promise<Res>
  appProof(id: string, body: Record<string, unknown>): Promise<Res>
  appDecide(id: string, body: Record<string, unknown>): Promise<Res>
  enrol(body: Record<string, unknown>): Promise<Res>
}

/** What a connector calls when the operator taps or types. */
export interface ApprovalHandler {
  tap(t: {
    channel: string
    userId: string
    id: string
    nonce: string
    action: "approve" | "deny"
  }): Promise<TapResult>
  typed(t: {
    channel: string
    userId: string
    text: string
    messageRef?: string
    replyTo?: string
  }): Promise<"consumed" | "ignored">
}
