import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { JwtKeyService } from '../tokens/jwt-key.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    keys: JwtKeyService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // RS256: verify with the public key; tokens carry a `kid` header.
      secretOrKey: keys.publicKey,
      algorithms: ['RS256'],
      issuer: 'mator',
      audience: config.get<string>('JWT_AUDIENCE') ?? 'mator-app',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.appUser.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();
    const { passwordHash: _, ...safe } = user;
    return safe;
  }
}
