export interface JwtPayload {
  sub: string;
  email: string | null;
  role: string;
}
