// Unit tests for UserController's multipart field selection. The avatar
// endpoint accepts the image under `avatar` (official), or the aliases `file`
// / `image`, and picks by priority so clients written against any of those
// field names work unchanged. AvatarService is mocked — this only asserts which
// file the controller forwards.

import { UserController } from './user.controller';

function file(fieldname: string) {
  return {
    fieldname,
    buffer: Buffer.from('x'),
    mimetype: 'image/jpeg',
    size: 10,
  };
}

function build() {
  const avatars = { upload: jest.fn().mockResolvedValue({ avatarUrl: 'u' }) };
  const controller = new UserController(
    {} as never,
    avatars as never,
    {} as never,
    {} as never,
  );
  return { controller, avatars };
}

const REQ = { user: { id: 'u1' } };

describe('UserController.uploadAvatar — field selection', () => {
  it('picks `avatar` when present (even alongside aliases)', () => {
    const { controller, avatars } = build();
    controller.uploadAvatar(REQ, [file('image'), file('file'), file('avatar')]);
    expect(avatars.upload).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ fieldname: 'avatar' }),
    );
  });

  it('falls back to `file` when there is no `avatar`', () => {
    const { controller, avatars } = build();
    controller.uploadAvatar(REQ, [file('image'), file('file')]);
    expect(avatars.upload).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ fieldname: 'file' }),
    );
  });

  it('accepts a generic `image` field', () => {
    const { controller, avatars } = build();
    controller.uploadAvatar(REQ, [file('image')]);
    expect(avatars.upload).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ fieldname: 'image' }),
    );
  });

  it('falls back to the first file for any other single field name', () => {
    const { controller, avatars } = build();
    controller.uploadAvatar(REQ, [file('photo')]);
    expect(avatars.upload).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ fieldname: 'photo' }),
    );
  });

  it('forwards undefined when no file was uploaded (service returns 415)', () => {
    const { controller, avatars } = build();
    controller.uploadAvatar(REQ, []);
    expect(avatars.upload).toHaveBeenCalledWith('u1', undefined);
  });
});
