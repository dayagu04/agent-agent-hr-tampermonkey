/** Decide when a chat action should be acknowledged to the backend. */
export function selectChatActionId(
  replyActionId: number | null | undefined,
  contactActionId: number | null | undefined,
): number | null {
  const id = replyActionId ?? contactActionId
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

/** A contact-only action is acknowledged only after a card was actually handled. */
export function shouldReportContactOnly(hasTextReply: boolean, contactSucceeded: boolean): boolean {
  return !hasTextReply && contactSucceeded
}
