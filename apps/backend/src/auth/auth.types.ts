export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  avatar: string;
}

export interface AccessTokenPayload {
  sub: string;
  typ: 'access';
}
