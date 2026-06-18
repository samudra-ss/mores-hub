import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '@prisma/client';

export const CurrentUser = createParamDecorator(
  (key: keyof User | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest().user as User;
    return key ? user?.[key] : user;
  },
);
