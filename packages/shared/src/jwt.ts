// JWT claim shapes shared by the control plane (signer) and authorizer (verifier).

export interface HostClaims {
  sub: string; // userId
  role: 'host';
  username: string;
  iat: number;
  exp: number;
}

export interface GuestClaims {
  sub: string; // guestId
  role: 'guest';
  roomId: string;
  iat: number;
  exp: number;
}

export type Claims = HostClaims | GuestClaims;

export function isHost(c: Claims): c is HostClaims {
  return c.role === 'host';
}
export function isGuest(c: Claims): c is GuestClaims {
  return c.role === 'guest';
}

export const HOST_TOKEN_TTL_SECONDS = 12 * 60 * 60;
export const GUEST_TOKEN_TTL_SECONDS = 8 * 60 * 60;
