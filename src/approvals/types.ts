/** What a connector and the approval engine say to each other. */
import type { Decision } from "./sign.ts"

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
}

export type Settled = {
  decision: Decision
  level: number
  reason?: string
  /** Who answered. */
  by?: string
}

export type TapResult = { ok: boolean; text: string; next?: "code" }

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
