/** Pure checks of trusted host grants. This is NOT an authentication service. */
import { Value } from "@sinclair/typebox/value";
import { AuthorizationContextSchema, type AuthorizationContext, type ExchangeAction, type ScopeForAction } from "../protocol/capabilities.js";
import { canonicalDigest } from "../protocol/idempotency.js";

export class AuthorizationRejectedError extends Error {
  readonly code = "AUTHORIZATION_REJECTED" as const;
  constructor(action: ExchangeAction) {
    super(`principal/action/scope authorization rejected: ${action}`);
    this.name = "AuthorizationRejectedError";
  }
}

/** Grants are loaded by the authenticated host, NEVER accepted from a caller. */
export function assertAuthorized<A extends ExchangeAction>(
  context: AuthorizationContext,
  action: A,
  scope: ScopeForAction<A>,
): void {
  const reject = (): never => { throw new AuthorizationRejectedError(action); };
  try { canonicalDigest(context); canonicalDigest(scope); } catch { reject(); }
  if (!Value.Check(AuthorizationContextSchema, context)) reject();
  if (context.grants.some((grant) => grant.principalId !== context.principalId)) reject();
  if (scope.kind === "owner" && scope.ownerId !== context.principalId) reject();
  const expected = canonicalDigest(scope);
  if (!context.grants.some((grant) => grant.action === action && canonicalDigest(grant.scope) === expected)) reject();
}
